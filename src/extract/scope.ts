import type { DatabaseType } from "../db/client.js";

/**
 * Incremental-extract scope.
 *
 * An extractor is either run over the WHOLE corpus (`ids === null`) or over a
 * bounded set of session ids that a preceding `normalize` marked dirty. The
 * bounded set is materialized into a connection-local temp table
 * `extract_scope(session_id)` so scoped SQL can reference it without hitting
 * SQLite's bound-parameter limit, and so the same fragment works no matter how
 * many sessions are in scope.
 *
 * Per-session extractors add `scopeAnd(scope)` / `scopeWhere(scope)` to their
 * source read and swap their table-wide `DELETE` for `scopedDelete(...)`.
 * Corpus-aggregate extractors (ngrams, templates, subagent linkage) ignore the
 * scope and always rebuild — they are cheap and their output depends on the
 * whole corpus.
 */
export interface ExtractScope {
  /** Session ids to (re)extract, or `null` for a full-corpus rebuild. */
  readonly ids: readonly string[] | null;
}

export const FULL_SCOPE: ExtractScope = { ids: null };

const SCOPE_TABLE = "extract_scope";

/** `true` when the extractor should filter to a bounded set of sessions. */
export function isScoped(
  scope: ExtractScope,
): scope is { ids: readonly string[] } {
  return scope.ids !== null;
}

/**
 * SQL ` AND <col> IN (...)` fragment for appending to an existing WHERE clause.
 * Empty string for a full rebuild.
 */
export function scopeAnd(scope: ExtractScope, col = "session_id"): string {
  return isScoped(scope)
    ? ` AND ${col} IN (SELECT session_id FROM ${SCOPE_TABLE})`
    : "";
}

/**
 * SQL ` WHERE <col> IN (...)` fragment for a source read that has no WHERE.
 * Empty string for a full rebuild.
 */
export function scopeWhere(scope: ExtractScope, col = "session_id"): string {
  return isScoped(scope)
    ? ` WHERE ${col} IN (SELECT session_id FROM ${SCOPE_TABLE})`
    : "";
}

/** Delete the in-scope rows of a fact table (whole table for a full rebuild). */
export function scopedDelete(
  db: DatabaseType,
  scope: ExtractScope,
  table: string,
  col = "session_id",
): void {
  db.prepare(`DELETE FROM ${table}${scopeWhere(scope, col)}`).run();
}

/**
 * Materialize `ids` into the temp scope table, run `fn` against a matching
 * `ExtractScope`, then drop the table. `ids === null` runs `fn` with the full
 * scope and touches no temp table.
 */
export function runScoped<T>(
  db: DatabaseType,
  ids: readonly string[] | null,
  fn: (scope: ExtractScope) => T,
): T {
  if (ids === null) return fn(FULL_SCOPE);

  db.prepare(
    `CREATE TEMP TABLE IF NOT EXISTS ${SCOPE_TABLE} (session_id TEXT PRIMARY KEY)`,
  ).run();
  db.prepare(`DELETE FROM ${SCOPE_TABLE}`).run();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO ${SCOPE_TABLE} (session_id) VALUES (?)`,
  );
  const load = db.transaction(() => {
    for (const id of ids) insert.run(id);
  });
  load();

  try {
    return fn({ ids });
  } finally {
    db.prepare(`DROP TABLE IF EXISTS ${SCOPE_TABLE}`).run();
  }
}
