import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeAnd, scopedDelete } from "./scope.js";

/**
 * self_resolutions: successful retries with their diagnostic context.
 *
 * Detection (deterministic, no LLM):
 *   Same `args_hash` failed (`exit_code != 0`) and later succeeded
 *   (`exit_code = 0`) inside the same session, with NO user message in between.
 *
 * For each pair we capture:
 *   - the failed and successful turns
 *   - the gap (how many turns elapsed before the successful retry)
 *   - the intermediate tool calls (the diagnosis steps)
 *   - the assistant's intervening text turns
 *
 * The table stores deterministic evidence that downstream analysis can
 * summarize without changing extraction behavior.
 */

interface PairRow {
  session_id: string;
  fail_turn: number;
  ok_turn: number;
  args_hash: string;
  tool_name: string;
  args_preview: string | null;
}

interface ToolCallSnap {
  turn: number;
  name: string;
  args_preview: string | null;
  exit_code: number | null;
}

interface ReasoningSnap {
  turn: number;
  text: string;
}

export function extractSelfResolutions(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  scopedDelete(db, scope, "self_resolutions");

  // Find the FIRST success per (session, args_hash) that follows a failure
  // with no user turn in between. We pick the EARLIEST failure too (so a
  // long retry loop becomes a single rich row, not N partial rows).
  const pairs = db
    .prepare<[], PairRow>(
      `SELECT
         tc_fail.session_id,
         MIN(tc_fail.turn)        AS fail_turn,
         MIN(tc_ok.turn)          AS ok_turn,
         tc_fail.args_hash,
         tc_fail.name             AS tool_name,
         tc_fail.args_preview
       FROM tool_calls tc_fail
       JOIN tool_calls tc_ok
         ON tc_ok.session_id = tc_fail.session_id
        AND tc_ok.args_hash  = tc_fail.args_hash
        AND tc_ok.turn       > tc_fail.turn
        AND tc_ok.exit_code  = 0
       WHERE tc_fail.exit_code != 0${scopeAnd(scope, "tc_fail.session_id")}
         AND NOT EXISTS (
           SELECT 1 FROM messages m
            WHERE m.session_id = tc_fail.session_id
              AND m.role = 'user'
              AND m.turn BETWEEN tc_fail.turn AND tc_ok.turn
         )
       GROUP BY tc_fail.session_id, tc_fail.args_hash`,
    )
    .all();

  const insert = db.prepare(
    `INSERT OR REPLACE INTO self_resolutions
       (session_id, fail_turn, ok_turn, gap_turns, tool_name, args_hash, args_preview,
        resolution_tool_calls_json, resolution_reasoning_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const p of pairs) {
      const intermediates = db
        .prepare<[string, number, number], ToolCallSnap>(
          `SELECT turn, name, args_preview, exit_code FROM tool_calls
            WHERE session_id = ? AND turn > ? AND turn < ?
            ORDER BY turn, idx`,
        )
        .all(p.session_id, p.fail_turn, p.ok_turn);

      const reasoning = db
        .prepare<[string, number, number], ReasoningSnap>(
          `SELECT turn, text FROM messages
            WHERE session_id = ? AND role = 'assistant'
              AND turn > ? AND turn < ?
              AND text IS NOT NULL AND length(text) > 0
            ORDER BY turn`,
        )
        .all(p.session_id, p.fail_turn, p.ok_turn);

      insert.run(
        p.session_id,
        p.fail_turn,
        p.ok_turn,
        p.ok_turn - p.fail_turn,
        p.tool_name,
        p.args_hash,
        p.args_preview,
        JSON.stringify(intermediates),
        JSON.stringify(reasoning),
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}
