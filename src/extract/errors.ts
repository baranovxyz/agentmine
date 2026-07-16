import type { DatabaseType } from "../db/client.js";
import { withLlmPreservation } from "./llmPreserve.js";

/**
 * tool_errors: one row per failed tool_call (exit_code != 0), with a
 * heuristic category derived from output text patterns. The
 * `error_category_llm` column (preserved across re-extracts) holds an
 * orthogonal LLM-derived label and is not written by this extractor.
 */
export type ErrorCategory =
  | "file_not_found"
  | "file_not_read"
  | "file_modified_since_read"
  | "string_not_unique"
  | "string_unchanged"
  | "user_rejected"
  | "parallel_cancelled"
  | "blocked_by_hook"
  | "permission"
  | "timeout"
  | "parse"
  | "rate_limit"
  | "network"
  | "not_found"
  | "conflict"
  | "unclassified";

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
  output_preview: string | null;
}

export function extractToolErrors(db: DatabaseType): number {
  let inserted = 0;
  withLlmPreservation(
    db,
    "tool_errors",
    ["session_id", "turn", "idx"],
    ["error_category_llm", "error_category_llm_source"],
    () => {
      db.prepare(`DELETE FROM tool_errors`).run();
      const rows = db
        .prepare<[], ToolCallRow>(
          `SELECT session_id, turn, idx, name, output_preview
             FROM tool_calls WHERE exit_code != 0`,
        )
        .all();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO tool_errors
          (session_id, turn, idx, tool_name, error_category, error_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const tx = db.transaction(() => {
        for (const r of rows) {
          const category = categorize(r.output_preview ?? "", r.name);
          insert.run(
            r.session_id,
            r.turn,
            r.idx,
            r.name,
            category,
            (r.output_preview ?? "").slice(0, 500),
          );
          inserted += 1;
        }
      });
      tx();
    },
  );
  return inserted;
}

function categorize(text: string, toolName: string): ErrorCategory {
  const t = text.toLowerCase();
  // Agent-CLI specific tool_use_errors come through verbatim; match them
  // before the generic patterns below so we don't lose them to "file_not_found".
  if (/file has not been read yet/.test(t)) return "file_not_read";
  if (
    /file has been modified since read|file content has changed since/.test(t)
  )
    return "file_modified_since_read";
  if (/found \d+ matches of the string to replace/.test(t))
    return "string_not_unique";
  if (/old_string and new_string are exactly the same/.test(t))
    return "string_unchanged";
  if (/the user doesn't want to proceed|tool use was rejected/.test(t))
    return "user_rejected";
  if (/cancelled: parallel tool call/.test(t)) return "parallel_cancelled";
  if (/<tool_use_error>blocked:|pretooluse:.*hook error/.test(t))
    return "blocked_by_hook";
  if (/no such file|does not exist|file not found|enoent/.test(t))
    return "file_not_found";
  if (/permission denied|eacces|operation not permitted|forbidden/.test(t))
    return "permission";
  if (/timeout|timed out|etimedout/.test(t)) return "timeout";
  if (/rate limit|429|too many requests/.test(t)) return "rate_limit";
  if (
    /econnrefused|enotfound|network|dns|unreachable|connection refused/.test(t)
  )
    return "network";
  if (/parse error|syntaxerror|invalid json|unexpected token/.test(t))
    return "parse";
  if (/already exists|conflict|409/.test(t)) return "conflict";
  if (/404|not found/.test(t)) return "not_found";
  if (toolName === "Bash" || toolName === "Shell") {
    if (/command not found|not found/.test(t)) return "not_found";
  }
  return "unclassified";
}
