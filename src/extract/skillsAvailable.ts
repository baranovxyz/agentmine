import type { DatabaseType } from "../db/client.js";
import { type ExtractScope, scopeWhere } from "./scope.js";

/**
 * `skills_available` is no longer extract-owned.
 *
 * It used to be rebuilt here by scanning every stored raw event — including an
 * unindexed substring match across the entire payload table, which became the
 * dominant cost of `extract` as the corpus grew. Payload now lives compressed
 * in a sibling archive, so listings are recovered at normalize time
 * from the parsed events already in memory (see `db/writer.ts`).
 *
 * Extract still reports the table in its receipt so the envelope shape stays
 * stable for agent consumers, but the number is now the rows present in scope
 * rather than rows this command inserted.
 */
export function countSkillsAvailable(
  db: DatabaseType,
  scope: ExtractScope,
): number {
  const row = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM skills_available ${scopeWhere(scope)}`,
    )
    .get();
  return row?.n ?? 0;
}
