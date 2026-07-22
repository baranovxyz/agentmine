import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";

/**
 * search_calls: one row per workspace lookup (grep / glob).
 *
 * Tool-name vocabulary across sources:
 *   - claude-code: Grep / Glob
 *   - opencode:    grep / glob
 *   - codex:       (no native tool; agents rely on `exec_command rg ...` which
 *                   shows up in shell_commands instead)
 *
 * Args we read:
 *   pattern  : the regex (Grep) or glob (Glob)
 *   path     : the search root (some calls omit it; defaults to cwd)
 *   include  : an optional file filter (Grep --include / opencode `include`)
 */

const TOOL_TO_KIND: Record<string, "grep" | "glob"> = {
  Grep: "grep",
  grep: "grep",
  Glob: "glob",
  glob: "glob",
};

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  args_json: string | null;
}

export function extractSearchCalls(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "search_calls");

  const rows = db
    .prepare<[string[]], ToolCallRow>(
      `SELECT session_id, turn, idx, name, args_json
         FROM tool_calls
        WHERE name IN (${Object.keys(TOOL_TO_KIND)
          .map(() => "?")
          .join(",")})${scopeAnd(scope)}`,
    )
    .all(Object.keys(TOOL_TO_KIND));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO search_calls
       (session_id, turn, idx, tool, pattern, path, include)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const tool = TOOL_TO_KIND[r.name];
      if (!tool) continue;
      if (!r.args_json) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pattern = pickString(args, ["pattern", "regex", "query"]);
      const path = pickString(args, ["path", "cwd", "directory"]);
      const include = pickString(args, ["include", "glob", "filter"]);
      // Drop calls that have no pattern AND no path — nothing useful to record.
      if (!pattern && !path) continue;
      insert.run(r.session_id, r.turn, r.idx, tool, pattern, path, include);
      inserted += 1;
    }
  });
  tx();
  return inserted;
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
