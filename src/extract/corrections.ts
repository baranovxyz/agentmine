import type { DatabaseType, Statement } from "../db/client.js";
import { withLlmPreservation } from "./llmPreserve.js";
import { isInjectedNoise } from "./noiseFilter.js";
import { type ExtractScope, scopedDelete, scopeWhere } from "./scope.js";

/**
 * user_corrections: every user turn (other than the first) that pushes back
 * on the agent, classified into one of seven kinds.
 *
 * Kind detection is ordered; first match wins. Confidence 0.5-0.9 reflects
 * how specific the match was. Optional enrichment is stored separately from
 * this deterministic classification.
 */

export type CorrectionKind =
  | "reject"
  | "undo"
  | "factual"
  | "style"
  | "scope"
  | "pivot"
  | "refine";

interface Rule {
  kind: CorrectionKind;
  confidence: number;
  test: (t: string) => boolean;
}

const REJECT =
  /^(no[,.!]?(\s|$)|stop\b|wait\b|that'?s wrong\b|that is wrong\b|incorrect\b|nope\b)/i;
const UNDO = /\b(revert|undo|rollback|roll back|take back|unwind)\b/i;
const FACTUAL_OPENER = /^(actually|in fact|not quite|it'?s not|it is not)\b/i;
const HAS_SPECIFIC = /(["'`][^"'`\n]{2,}["'`]|\b\d+\b|[A-Z][a-zA-Z]{2,})/;
// Use Unicode-aware boundaries so Cyrillic "по-русски" matches. `\b` in JS
// only understands ASCII word chars, so we bracket with \P{L} lookups.
const STYLE =
  /(?:^|[^\p{L}])(shorter|longer|simpler|in russian|in english|по[- ]русски|по[- ]английски|rewrite|rephrase|tone|formal|casual|concise)(?=[^\p{L}]|$)/iu;
const SCOPE =
  /\b(only|just|don'?t (touch|change|modify)|keep|leave)\b.*\b([\w/.-]+\.(ts|js|py|md|rs|go|rb|java|tsx|jsx|sh)|\b(module|service|package|component|function|file)\b)/i;
const PIVOT =
  /^(let'?s|instead\b|forget\b|different approach|start over|scratch that)\b/i;
const REFINE = /^(actually|also|and\b|plus\b|can you|could you|please)/i;

const RULES: Rule[] = [
  { kind: "reject", confidence: 0.9, test: (t) => REJECT.test(t) },
  { kind: "undo", confidence: 0.9, test: (t) => UNDO.test(t) },
  {
    kind: "factual",
    confidence: 0.8,
    test: (t) => FACTUAL_OPENER.test(t) && HAS_SPECIFIC.test(t),
  },
  { kind: "style", confidence: 0.7, test: (t) => STYLE.test(t) },
  { kind: "scope", confidence: 0.7, test: (t) => SCOPE.test(t) },
  { kind: "pivot", confidence: 0.7, test: (t) => PIVOT.test(t) },
  { kind: "refine", confidence: 0.5, test: (t) => REFINE.test(t) },
];

export function classify(
  text: string,
): { kind: CorrectionKind; confidence: number } | null {
  const t = text.trimStart();
  if (!t) return null;
  for (const r of RULES)
    if (r.test(t)) return { kind: r.kind, confidence: r.confidence };
  return null;
}

interface MessageRow {
  session_id: string;
  turn: number;
  role: string;
  ts: number | null;
  text: string;
}

interface SessionRow {
  id: string;
  source: string;
  project_path: string | null;
}

/**
 * Populate user_corrections. Scans all user turns except the first one in each
 * session; classifies them; resolves `preceding_turn` (previous assistant turn),
 * `preceding_tool_calls`, `response_time_ms`, and `followed_by_revert`.
 */
export function extractUserCorrections(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  withLlmPreservation(
    db,
    "user_corrections",
    ["session_id", "turn"],
    ["kind_llm", "kind_llm_source"],
    () => {
      scopedDelete(db, scope, "user_corrections");
      const sessions = db
        .prepare<[], SessionRow>(
          `SELECT id, source, project_path FROM sessions${scopeWhere(scope, "id")}`,
        )
        .all();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO user_corrections
          (session_id, turn, kind, confidence, text, preceding_turn,
           preceding_tool_calls, response_time_ms, followed_by_revert, source, project_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const tx = db.transaction(() => {
        for (const s of sessions) {
          const messages = db
            .prepare<[string], MessageRow>(
              `SELECT session_id, turn, role, ts, text FROM messages WHERE session_id = ? ORDER BY turn`,
            )
            .all(s.id);
          populate(db, s, messages, insert);
        }
      });
      tx();
    },
  );
  return (
    db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM user_corrections`)
      .get()?.n ?? 0
  );
}

function populate(
  db: DatabaseType,
  session: SessionRow,
  messages: MessageRow[],
  insert: Statement<unknown[]>,
): void {
  // Precompute assistant-turn → next tool_use count
  const toolCallsByTurn = db
    .prepare<[string], { turn: number; n: number }>(
      `SELECT turn, COUNT(*) AS n FROM tool_calls WHERE session_id = ? GROUP BY turn`,
    )
    .all(session.id);
  const tcByTurn = new Map(toolCallsByTurn.map((r) => [r.turn, r.n]));

  let firstUserSeen = false;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    if (!firstUserSeen) {
      firstUserSeen = true;
      continue;
    }
    // Skip turns injected by the agent or runtime rather than authored by the
    // user (skill bodies, context preambles, tool-generated feedback, etc.).
    // See extract/noiseFilter.ts.
    if (isInjectedNoise(msg.text)) continue;
    const classification = classify(msg.text);
    if (!classification) continue;

    // find preceding assistant turn
    let precedingTurn: number | null = null;
    let precedingTs: number | null = null;
    let precedingToolCalls = 0;
    for (let j = i - 1; j >= 0; j -= 1) {
      const m = messages[j];
      if (m && m.role === "assistant") {
        precedingTurn = m.turn;
        precedingTs = m.ts;
        precedingToolCalls = tcByTurn.get(m.turn) ?? 0;
        break;
      }
    }

    const responseTime =
      precedingTs !== null && msg.ts !== null
        ? (msg.ts - precedingTs) * 1000
        : null;

    const followedByRevert = detectFollowedByRevert(
      db,
      session.id,
      msg.turn,
      precedingTurn,
    );

    insert.run(
      session.id,
      msg.turn,
      classification.kind,
      classification.confidence,
      msg.text.slice(0, 500),
      precedingTurn,
      precedingToolCalls,
      responseTime,
      followedByRevert,
      session.source,
      session.project_path,
    );
  }
}

const EDIT_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "StrReplace",
  "ReplaceFile",
  "EditFile",
]);

/**
 * Detect whether a correction was followed by a revert action.
 *
 * Returns:
 *   2 - exact string reversal: an edit in the next 15 turns restores the exact
 *       content that was present before the preceding assistant turn's edit.
 *   1 - same-file edit: an edit tool hit the same file within the next 10 turns,
 *       OR a git revert/reset --hard shell command was found.
 *   0 - no revert detected.
 */
function detectFollowedByRevert(
  db: DatabaseType,
  sessionId: string,
  turn: number,
  precedingTurn: number | null,
): 0 | 1 | 2 {
  // --- Tier 2: exact string reversal ---
  if (precedingTurn !== null) {
    // Collect (file_path, old_string) from edit tool calls at precedingTurn.
    const priorEdits = db
      .prepare<[string, number], { args_json: string | null }>(
        `SELECT args_json FROM tool_calls
         WHERE session_id = ? AND turn = ? AND name IN ('Edit','StrReplace','MultiEdit','ReplaceFile','EditFile')`,
      )
      .all(sessionId, precedingTurn);

    const targets = new Map<string, string>(); // file_path -> old_string
    for (const row of priorEdits) {
      if (!row.args_json) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(row.args_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const path = pickStr(args, ["file_path", "path"]);
      // For MultiEdit, edits is an array; take the first edit's old_string.
      const edits = args["edits"];
      let oldStr: string | null = null;
      if (Array.isArray(edits) && edits.length > 0) {
        oldStr = pickStr(edits[0] as Record<string, unknown>, [
          "old_string",
          "old_str",
        ]);
      } else {
        oldStr = pickStr(args, ["old_string", "old_str"]);
      }
      if (path && oldStr) targets.set(path, oldStr);
    }

    if (targets.size > 0) {
      const postEdits = db
        .prepare<[string, number, number], { args_json: string | null }>(
          `SELECT args_json FROM tool_calls
           WHERE session_id = ? AND turn > ? AND turn <= ?
             AND name IN ('Edit','StrReplace','MultiEdit','ReplaceFile','EditFile','Write')`,
        )
        .all(sessionId, turn, turn + 15);

      for (const row of postEdits) {
        if (!row.args_json) continue;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(row.args_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        const path = pickStr(args, ["file_path", "path"]);
        if (!path) continue;
        const expectedOld = targets.get(path);
        if (!expectedOld) continue;
        // For MultiEdit, check any edit in the array.
        const edits = args["edits"];
        if (Array.isArray(edits)) {
          for (const e of edits) {
            const newStr = pickStr(e as Record<string, unknown>, [
              "new_string",
              "new_str",
              "content",
            ]);
            if (newStr === expectedOld) return 2;
          }
        } else {
          const newStr = pickStr(args, ["new_string", "new_str", "content"]);
          if (newStr === expectedOld) return 2;
        }
      }
    }
  }

  // --- Tier 1a: same-file edit ---
  if (precedingTurn !== null) {
    const priorPaths = db
      .prepare<[string, number], { args_json: string | null }>(
        `SELECT args_json FROM tool_calls
         WHERE session_id = ? AND turn = ?
           AND name IN ('Edit','StrReplace','MultiEdit','ReplaceFile','EditFile','Write')`,
      )
      .all(sessionId, precedingTurn);

    const filePaths = new Set<string>();
    for (const row of priorPaths) {
      if (!row.args_json) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(row.args_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const p = pickStr(args, ["file_path", "path"]);
      if (p) filePaths.add(p);
    }

    if (filePaths.size > 0) {
      const postEdits = db
        .prepare<[string, number, number], { args_json: string | null }>(
          `SELECT args_json FROM tool_calls
           WHERE session_id = ? AND turn > ? AND turn <= ?
             AND name IN ('Edit','StrReplace','MultiEdit','ReplaceFile','EditFile','Write')`,
        )
        .all(sessionId, turn, turn + 10);

      for (const row of postEdits) {
        if (!row.args_json) continue;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(row.args_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        const p = pickStr(args, ["file_path", "path"]);
        if (p && filePaths.has(p)) return 1;
      }
    }
  }

  // --- Tier 1b: git revert/reset --hard shell command ---
  const shellRows = db
    .prepare<[string, number, number], { cmd_full: string }>(
      `SELECT cmd_full FROM shell_commands
       WHERE session_id = ? AND turn > ? AND turn <= ?`,
    )
    .all(sessionId, turn, turn + 10);
  for (const r of shellRows) {
    if (/\bgit\s+(revert|restore|reset\s+--hard)\b/.test(r.cmd_full)) return 1;
  }

  return 0;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

// Keep the import reference used above.
void EDIT_TOOLS;
