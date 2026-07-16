import type { DatabaseType } from "../db/client.js";

/**
 * Run a destructive heuristic rebuild (DELETE+INSERT) while preserving
 * LLM-classified columns. Pattern: snapshot rows where any LLM column is
 * non-null, run the rebuild, then UPDATE-back the LLM columns by primary
 * key. Rows whose primary key no longer exists after rebuild silently
 * lose their LLM verdict, which matches what we want — the underlying
 * fact is gone.
 */
export function withLlmPreservation(
  db: DatabaseType,
  table: string,
  primaryKey: ReadonlyArray<string>,
  llmColumns: ReadonlyArray<string>,
  rebuild: () => void,
): void {
  const cols = [...primaryKey, ...llmColumns];
  const whereAnyLlm = llmColumns.map((c) => `${c} IS NOT NULL`).join(" OR ");
  const saved = db
    .prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${whereAnyLlm}`)
    .all() as Array<Record<string, unknown>>;

  rebuild();

  if (saved.length === 0) return;
  const setClause = llmColumns.map((c) => `${c} = @${c}`).join(", ");
  const whereClause = primaryKey.map((c) => `${c} = @${c}`).join(" AND ");
  const update = db.prepare(
    `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`,
  );
  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const r of rows) update.run(r);
  });
  tx(saved);
}
