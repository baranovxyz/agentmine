import type { DatabaseType } from "../db/client.js";

/**
 * user_interruptions: a user turn that arrived while the agent was clearly
 * mid-task and surprised it. Heuristic:
 *
 *   - The previous assistant turn made >= 3 tool calls (the agent was busy).
 *   - The user turn arrived within 5 seconds of the last assistant turn's ts.
 *   - The user text is short (< 80 chars) -- "stop", "wait", "no, do X" shape.
 *
 * `reason_hint` is a coarse heuristic: matches the same regexes as
 * `corrections.ts` for `reject` / `pivot`; otherwise null.
 */

const SHORT_LIMIT = 80;
const FAST_RESPONSE_MS = 5_000;
const BUSY_TOOL_CALLS = 3;

const REJECT_RX = /^\s*(no|stop|wait|nope|hold on|hold up|cancel)\b/i;
const PIVOT_RX =
  /^\s*(let'?s|instead|forget|different approach|start over|scratch that)\b/i;

interface MessageRow {
  session_id: string;
  turn: number;
  role: string;
  ts: number | null;
  text: string;
}

export function extractUserInterruptions(db: DatabaseType): number {
  db.prepare(`DELETE FROM user_interruptions`).run();

  const sessions = db
    .prepare<[], { id: string }>(`SELECT id FROM sessions`)
    .all();

  const insert = db.prepare(
    `INSERT OR IGNORE INTO user_interruptions
       (session_id, turn, response_time_ms, reason_hint)
     VALUES (?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const s of sessions) {
      const messages = db
        .prepare<[string], MessageRow>(
          `SELECT session_id, turn, role, ts, text FROM messages WHERE session_id = ? ORDER BY turn`,
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

      for (let i = 1; i < messages.length; i += 1) {
        const msg = messages[i]!;
        const prev = messages[i - 1];
        if (msg.role !== "user") continue;
        if (!prev || prev.role !== "assistant") continue;
        const prevToolCalls = tcByTurn.get(prev.turn) ?? 0;
        if (prevToolCalls < BUSY_TOOL_CALLS) continue;
        const text = msg.text ?? "";
        if (text.length === 0 || text.length > SHORT_LIMIT) continue;

        let responseMs: number | null = null;
        if (typeof msg.ts === "number" && typeof prev.ts === "number") {
          responseMs = (msg.ts - prev.ts) * 1000;
          if (responseMs > FAST_RESPONSE_MS) continue;
        }
        // If we have no timestamps, accept the heuristic from text + busy-prev.

        let reason: "correction" | "pivot" | "unknown" = "unknown";
        if (REJECT_RX.test(text)) reason = "correction";
        else if (PIVOT_RX.test(text)) reason = "pivot";

        insert.run(s.id, msg.turn, responseMs, reason);
        inserted += 1;
      }
    }
  });
  tx();
  return inserted;
}
