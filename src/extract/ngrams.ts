import type { DatabaseType } from "../db/client.js";

/**
 * tool_call_ngrams: aggregate counts of n-tool sequences across the corpus.
 *
 * For each session, slide a window of size n ∈ {2,3,4} over the chronologically
 * ordered tool-call name sequence (one record per tool_call regardless of
 * which turn it lives on). Aggregate by sequence; keep entries with count >= 3.
 *
 * Each kept row stores `count`, distinct `sessions`, and one example pointer
 * (`example_session_id`, `example_start_turn`) for fast drill-down.
 */

const N_VALUES = [2, 3, 4] as const;
const MIN_COUNT = 3;

interface ToolCallRow {
  session_id: string;
  turn: number;
  idx: number;
  name: string;
}

export interface NgramAgg {
  sequence: string;
  n: number;
  count: number;
  sessions: number;
  example_session_id: string;
  example_start_turn: number;
}

/**
 * Aggregate n-tool sequences from a flat tool_calls row set already
 * ordered by (session_id, turn, idx). Shared between the corpus-wide
 * extractor and on-demand `top sequences --project <p>` filtering.
 */
export function aggregateNgrams(
  rows: ToolCallRow[],
  opts: { nValues?: readonly number[]; minCount?: number } = {},
): NgramAgg[] {
  const nValues = opts.nValues ?? N_VALUES;
  const minCount = opts.minCount ?? MIN_COUNT;

  const bySession = new Map<string, ToolCallRow[]>();
  for (const r of rows) {
    let arr = bySession.get(r.session_id);
    if (!arr) {
      arr = [];
      bySession.set(r.session_id, arr);
    }
    arr.push(r);
  }

  interface AggInternal {
    sequence: string;
    n: number;
    count: number;
    sessions: Set<string>;
    exampleSessionId: string;
    exampleStartTurn: number;
  }

  const aggMap = new Map<string, AggInternal>();
  for (const [sid, calls] of bySession) {
    for (const n of nValues) {
      for (let i = 0; i + n <= calls.length; i += 1) {
        const window = calls.slice(i, i + n);
        const sequence = window.map((c) => c.name).join(" → ");
        const key = `${n}::${sequence}`;
        let agg = aggMap.get(key);
        if (!agg) {
          agg = {
            sequence,
            n,
            count: 0,
            sessions: new Set(),
            exampleSessionId: sid,
            exampleStartTurn: window[0]!.turn,
          };
          aggMap.set(key, agg);
        }
        agg.count += 1;
        agg.sessions.add(sid);
      }
    }
  }

  const out: NgramAgg[] = [];
  for (const agg of aggMap.values()) {
    if (agg.count < minCount) continue;
    out.push({
      sequence: agg.sequence,
      n: agg.n,
      count: agg.count,
      sessions: agg.sessions.size,
      example_session_id: agg.exampleSessionId,
      example_start_turn: agg.exampleStartTurn,
    });
  }
  return out;
}

export function extractToolCallNgrams(db: DatabaseType): number {
  db.prepare(`DELETE FROM tool_call_ngrams`).run();

  const rows = db
    .prepare<[], ToolCallRow>(
      `SELECT session_id, turn, idx, name FROM tool_calls
       ORDER BY session_id, turn, idx`,
    )
    .all();

  const aggs = aggregateNgrams(rows);

  const insert = db.prepare(
    `INSERT OR REPLACE INTO tool_call_ngrams
       (sequence, n, count, sessions, example_session_id, example_start_turn)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  const tx = db.transaction(() => {
    for (const agg of aggs) {
      insert.run(
        agg.sequence,
        agg.n,
        agg.count,
        agg.sessions,
        agg.example_session_id,
        agg.example_start_turn,
      );
      inserted += 1;
    }
  });
  tx();
  return inserted;
}
