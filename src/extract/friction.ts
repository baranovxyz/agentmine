import type { DatabaseType } from "../db/client.js";
import { withLlmPreservation } from "./llmPreserve.js";

/**
 * friction_events: heuristic markers of agent struggle.
 *
 * Four rule families:
 *
 *   - retry_same_cmd            same shell cmd_full failed then re-run within 3 turns
 *   - repeated_file_read        same path Read >= 4 times in one session
 *   - tool_error_loop           >= 3 consecutive failed tool_calls of the same name
 *   - long_unproductive_chain   >= 10 tool_calls between consecutive user turns
 */

interface ShellRow {
  session_id: string;
  turn: number;
  idx: number;
  cmd_full: string | null;
  exit_code: number | null;
}

interface FilesRow {
  session_id: string;
  turn: number;
  path: string;
}

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  exit_code: number | null;
}

interface MessageTurn {
  session_id: string;
  turn: number;
  role: string;
}

export function extractFrictionEvents(db: DatabaseType): number {
  let inserted = 0;
  withLlmPreservation(
    db,
    "friction_events",
    ["session_id", "turn", "idx"],
    ["type_llm", "type_llm_source"],
    () => {
      db.prepare(`DELETE FROM friction_events`).run();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO friction_events (session_id, turn, idx, type, context)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const tx = db.transaction(() => {
        let cursor = 0;
        const next = () => cursor++;
        inserted += detectRetrySameCmd(db, insert, next);
        inserted += detectRepeatedFileRead(db, insert, next);
        inserted += detectToolErrorLoop(db, insert, next);
        inserted += detectLongUnproductiveChain(db, insert, next);
      });
      tx();
    },
  );
  return inserted;
}

type Inserter = (
  sessionId: string,
  turn: number,
  idx: number,
  type: string,
  context: string,
) => void;

function detectRetrySameCmd(
  db: DatabaseType,
  insertStmt: { run: Inserter },
  next: () => number,
): number {
  const rows = db
    .prepare<[], ShellRow>(
      `SELECT session_id, turn, idx, cmd_full, exit_code FROM shell_commands
       ORDER BY session_id, turn, idx`,
    )
    .all();
  let n = 0;
  // For each failed cmd, look ahead 3 turns for same cmd_full re-run.
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    if (r.exit_code === 0 || r.exit_code === null) continue;
    if (!r.cmd_full) continue;
    for (let j = i + 1; j < rows.length; j += 1) {
      const s = rows[j]!;
      if (s.session_id !== r.session_id) break;
      if (s.turn - r.turn > 3) break;
      if (s.cmd_full === r.cmd_full) {
        insertStmt.run(
          r.session_id,
          r.turn,
          next(),
          "retry_same_cmd",
          r.cmd_full.slice(0, 300),
        );
        n += 1;
        break;
      }
    }
  }
  return n;
}

function detectRepeatedFileRead(
  db: DatabaseType,
  insertStmt: { run: Inserter },
  next: () => number,
): number {
  const rows = db
    .prepare<[], FilesRow>(
      `SELECT session_id, turn, path FROM files_touched WHERE op = 'read'`,
    )
    .all();
  const counts = new Map<string, { turn: number; n: number }>();
  for (const r of rows) {
    const key = `${r.session_id}::${r.path}`;
    const cur = counts.get(key);
    if (cur) {
      cur.n += 1;
    } else {
      counts.set(key, { turn: r.turn, n: 1 });
    }
  }
  let n = 0;
  for (const [key, info] of counts) {
    if (info.n < 4) continue;
    const [sessionId, path] = key.split("::");
    insertStmt.run(
      sessionId!,
      info.turn,
      next(),
      "repeated_file_read",
      `${path} (${info.n} reads)`,
    );
    n += 1;
  }
  return n;
}

function detectToolErrorLoop(
  db: DatabaseType,
  insertStmt: { run: Inserter },
  next: () => number,
): number {
  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, name, exit_code FROM tool_calls
       ORDER BY session_id, turn, idx`,
    )
    .all();
  let n = 0;
  let runStart = 0;
  let runName: string | null = null;
  let runSession: string | null = null;
  let runLen = 0;
  let runStartTurn = 0;

  const flush = (endIdx: number): void => {
    if (runLen >= 3 && runName && runSession) {
      insertStmt.run(
        runSession,
        runStartTurn,
        next(),
        "tool_error_loop",
        `${runName} ×${runLen}`,
      );
      n += 1;
    }
    runStart = endIdx;
    runName = null;
    runSession = null;
    runLen = 0;
  };

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const failed = r.exit_code !== 0 && r.exit_code !== null;
    if (failed && r.session_id === runSession && r.name === runName) {
      runLen += 1;
    } else {
      flush(i);
      if (failed) {
        runSession = r.session_id;
        runName = r.name;
        runLen = 1;
        runStartTurn = r.turn;
      }
    }
  }
  flush(rows.length);
  void runStart;
  return n;
}

function detectLongUnproductiveChain(
  db: DatabaseType,
  insertStmt: { run: Inserter },
  next: () => number,
): number {
  const sessions = db
    .prepare<[], { id: string }>(`SELECT id FROM sessions`)
    .all();
  let n = 0;
  for (const s of sessions) {
    const messages = db
      .prepare<[string], MessageTurn>(
        `SELECT session_id, turn, role FROM messages WHERE session_id = ? ORDER BY turn`,
      )
      .all(s.id);
    const tcByTurn = new Map(
      db
        .prepare<[string], { turn: number; n: number }>(
          `SELECT turn, COUNT(*) AS n FROM tool_calls WHERE session_id = ? GROUP BY turn`,
        )
        .all(s.id)
        .map((r) => [r.turn, r.n]),
    );

    let chainStart = 0;
    let chainTools = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]!;
      if (m.role === "user") {
        if (chainTools >= 10) {
          insertStmt.run(
            s.id,
            chainStart,
            next(),
            "long_unproductive_chain",
            `${chainTools} tool calls between user turns`,
          );
          n += 1;
        }
        chainStart = m.turn;
        chainTools = 0;
      } else {
        chainTools += tcByTurn.get(m.turn) ?? 0;
      }
    }
    if (chainTools >= 10) {
      insertStmt.run(
        s.id,
        chainStart,
        next(),
        "long_unproductive_chain",
        `${chainTools} tool calls between user turns`,
      );
      n += 1;
    }
  }
  return n;
}
