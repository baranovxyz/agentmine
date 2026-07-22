import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";

/**
 * todo_events: counts a TodoWrite call's status distribution at the moment
 * it was made. Useful for "did the agent finish what it set out to do?"
 * queries and for catching long todos that never get marked completed.
 */

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  args_json: string | null;
}

export function extractTodoEvents(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "todo_events");

  // Cross-source tool names:
  //   claude-code: TodoWrite       (args.todos[].status)
  //   opencode:    todowrite       (args.todos[].status)
  //   codex:       update_plan     (args.plan[].status)
  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, args_json
         FROM tool_calls
        WHERE name IN ('TodoWrite', 'todo_write', 'todoWrite', 'todowrite', 'update_plan')${scopeAnd(scope)}`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO todo_events
       (session_id, turn, idx, total, pending, in_progress, completed, cancelled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!r.args_json) continue;
      let args: unknown;
      try {
        args = JSON.parse(r.args_json);
      } catch {
        continue;
      }
      const todos = extractTodos(args);
      if (todos.length === 0) continue;
      let pending = 0,
        inProgress = 0,
        completed = 0,
        cancelled = 0;
      for (const t of todos) {
        switch (t) {
          case "pending":
            pending += 1;
            break;
          case "in_progress":
            inProgress += 1;
            break;
          case "completed":
            completed += 1;
            break;
          case "cancelled":
            cancelled += 1;
            break;
        }
      }
      insert.run(
        r.session_id,
        r.turn,
        r.idx,
        todos.length,
        pending,
        inProgress,
        completed,
        cancelled,
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}

function extractTodos(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const obj = args as Record<string, unknown>;
  // `plan` is codex's update_plan key; `todos` is CC + opencode; `items`
  // is a defensive third name some adapters have used.
  const list = obj["todos"] ?? obj["plan"] ?? obj["items"];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const status = (item as Record<string, unknown>)["status"];
      if (typeof status === "string") out.push(status);
    }
  }
  return out;
}
