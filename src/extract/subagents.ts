import { z } from "zod";
import type { DatabaseType } from "../db/client.js";

/**
 * subagent_invocations: every subagent dispatch from a parent session.
 *
 * Matches common dispatch tool-name conventions:
 *   - `Task` / `task`
 *   - `Agent` / `agent`
 *   - `Subagent` / `subagent`
 *   - `spawn_agent`
 *
 * Records the parent's invocation point (parent_session_id, parent_turn),
 * subagent_type, and task text.
 * `child_session_id` is populated when normalized child sessions expose a
 * matching `parent_session_id`; otherwise it remains NULL.
 */

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  args_json: string | null;
  output_preview: string | null;
  output_text: string | null;
}

interface ChildRow {
  id: string;
  source: string;
  external_id: string | null;
  parent_session_id: string;
  agent_type: string | null;
  started_at: number | null;
}

interface Invocation {
  row: ToolCallRow;
  subagentType: string | null;
  taskText: string;
  stableAgentKey: string | null;
  outputAgentId: string | null;
  dispatchFailed: boolean;
  childId: string | null;
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

export function extractSubagentInvocations(db: DatabaseType): number {
  db.prepare(`DELETE FROM subagent_invocations`).run();

  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT tc.session_id, tc.turn, tc.idx, tc.name, tc.args_json,
              tc.output_preview, outputs.output_text
         FROM tool_calls tc
         LEFT JOIN tool_outputs outputs
           ON outputs.session_id = tc.session_id
          AND outputs.turn = tc.turn
          AND outputs.idx = tc.idx
        WHERE lower(tc.name) IN ('task', 'agent', 'subagent', 'spawn_agent')
        ORDER BY tc.session_id, tc.turn, tc.idx`,
    )
    .all();

  // Pre-fetch child sessions keyed by direct parent. Stable ordering makes the
  // final best-effort fallback deterministic across SQLite query plans.
  const childByParent = new Map<string, ChildRow[]>();
  const childRows = db
    .prepare<[], ChildRow>(
      `SELECT id, source, external_id, parent_session_id, agent_type, started_at
         FROM sessions
        WHERE parent_session_id IS NOT NULL
        ORDER BY parent_session_id,
                 CASE WHEN started_at IS NULL THEN 1 ELSE 0 END,
                 started_at,
                 id`,
    )
    .all();
  for (const c of childRows) {
    let arr = childByParent.get(c.parent_session_id);
    if (!arr) {
      arr = [];
      childByParent.set(c.parent_session_id, arr);
    }
    arr.push(c);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO subagent_invocations
       (parent_session_id, parent_turn, idx, child_session_id, subagent_type, task_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const invocations: Invocation[] = [];
  for (const row of rows) {
    const args = parseJsonObject(row.args_json);
    if (!args) continue;
    const subagentType = pickString(args, [
      "subagent_type",
      "subagentType",
      "agent_type",
      "agentType",
      "task_name",
      "taskName",
      "agent",
      "type",
    ]);
    const taskText = pickTaskText(row.name, args);

    // Skip rows where we have no type AND no meaningful task text - these are
    // tool calls that matched the name filter but aren't real dispatches.
    if (!subagentType && !taskText.trim()) continue;

    const output = row.output_text ?? row.output_preview;
    invocations.push({
      row,
      subagentType,
      taskText,
      stableAgentKey: pickString(args, [
        "task_name",
        "taskName",
        "agent_path",
        "agentPath",
        "agent_type",
        "agentType",
        "subagent_type",
        "subagentType",
      ]),
      outputAgentId: extractOutputAgentId(output),
      dispatchFailed:
        row.name.toLowerCase() === "spawn_agent" && spawnDispatchFailed(output),
      childId: null,
    });
  }

  // Reserve source-provided ids first across the whole batch. A failed earlier
  // dispatch must not consume a child that a later dispatch identifies exactly.
  const claimedByParent = new Map<string, Set<string>>();
  for (const invocation of invocations) {
    if (invocation.dispatchFailed || !invocation.outputAgentId) continue;
    const child = findExactChild(
      childByParent.get(invocation.row.session_id) ?? [],
      invocation.outputAgentId,
      claimedChildren(claimedByParent, invocation.row.session_id),
    );
    if (child) claimChild(invocation, child, claimedByParent);
  }

  // Codex v2 exposes stable task paths/names even when an output id is absent.
  // Guardian review sessions are real children, but never delegated-worker
  // candidates for path matching or the ordered fallback.
  for (const invocation of invocations) {
    const stableAgentKey = invocation.stableAgentKey;
    if (invocation.dispatchFailed || invocation.childId || !stableAgentKey)
      continue;
    const claimed = claimedChildren(claimedByParent, invocation.row.session_id);
    const child = (childByParent.get(invocation.row.session_id) ?? []).find(
      (candidate) =>
        !isCodexGuardian(candidate) &&
        !claimed.has(candidate.id) &&
        agentKeyMatches(candidate.agent_type, stableAgentKey),
    );
    if (child) claimChild(invocation, child, claimedByParent);
  }

  for (const invocation of invocations) {
    if (invocation.dispatchFailed || invocation.childId) continue;
    const claimed = claimedChildren(claimedByParent, invocation.row.session_id);
    const child = (childByParent.get(invocation.row.session_id) ?? []).find(
      (candidate) => !isCodexGuardian(candidate) && !claimed.has(candidate.id),
    );
    if (child) claimChild(invocation, child, claimedByParent);
  }

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const invocation of invocations) {
      const r = invocation.row;
      insert.run(
        r.session_id,
        r.turn,
        r.idx,
        invocation.childId,
        invocation.subagentType,
        invocation.taskText.slice(0, 500),
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = JsonObjectSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function pickTaskText(toolName: string, args: Record<string, unknown>): string {
  const taskText = pickString(args, [
    "message",
    "prompt",
    "task",
    "description",
    "instructions",
  ]);
  if (
    toolName.toLowerCase() === "spawn_agent" &&
    taskText !== null &&
    isOpaqueCodexMessage(taskText)
  ) {
    return pickString(args, ["task_name", "taskName"]) ?? "";
  }
  return taskText ?? "";
}

function isOpaqueCodexMessage(value: string): boolean {
  return (
    value.length >= 80 &&
    value.startsWith("gAAAA") &&
    /^[A-Za-z0-9_-]+={0,2}$/.test(value)
  );
}

function isCodexGuardian(candidate: ChildRow): boolean {
  return candidate.source === "codex" && candidate.agent_type === "guardian";
}

function spawnDispatchFailed(output: string | null): boolean {
  if (!output) return false;
  const normalized = output.toLowerCase();
  return (
    normalized.includes("spawn failed") ||
    normalized.includes("thread limit reached") ||
    normalized.includes("already exists") ||
    normalized.includes("omit agent_type") ||
    normalized.includes("failed to spawn") ||
    normalized.includes("cannot spawn")
  );
}

function extractOutputAgentId(output: string | null): string | null {
  const parsed = parseJsonObject(output);
  if (!parsed) return null;
  return pickString(parsed, [
    "agent_id",
    "agentId",
    "child_session_id",
    "childSessionId",
    "session_id",
    "sessionId",
  ]);
}

function claimedChildren(
  claimedByParent: Map<string, Set<string>>,
  parentId: string,
): Set<string> {
  let claimed = claimedByParent.get(parentId);
  if (!claimed) {
    claimed = new Set<string>();
    claimedByParent.set(parentId, claimed);
  }
  return claimed;
}

function findExactChild(
  candidates: ChildRow[],
  outputAgentId: string,
  claimed: Set<string>,
): ChildRow | undefined {
  return candidates.find(
    (candidate) =>
      !claimed.has(candidate.id) &&
      (candidate.id === outputAgentId ||
        candidate.external_id === outputAgentId),
  );
}

function claimChild(
  invocation: Invocation,
  child: ChildRow,
  claimedByParent: Map<string, Set<string>>,
): void {
  invocation.childId = child.id;
  claimedChildren(claimedByParent, invocation.row.session_id).add(child.id);
}

function agentKeyMatches(
  agentType: string | null,
  stableAgentKey: string,
): boolean {
  if (!agentType) return false;
  const type = normalizeAgentKey(agentType);
  const key = normalizeAgentKey(stableAgentKey);
  return type === key || type.endsWith(`/${key}`) || key.endsWith(`/${type}`);
}

function normalizeAgentKey(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, "");
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
