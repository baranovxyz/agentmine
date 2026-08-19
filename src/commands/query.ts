import { defineCommand } from "citty";
import { z } from "zod";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { type DatabaseType, dbExists, openDb } from "../db/client.js";
import {
  readCommandWarnings,
  readWithFreshnessSnapshot,
} from "../db/freshness.js";

const SCHEMA_DISCOVERY_HINT =
  "To discover the schema run `agentmine schema --tables` or `agentmine schema --table=<name>`.";

const NON_SELECT_MESSAGE = `Only read-only SELECT / WITH / EXPLAIN / introspection PRAGMA queries allowed (the database is opened read-only). ${SCHEMA_DISCOVERY_HINT}`;

export const queryCommand = defineCommand({
  meta: {
    name: "query",
    description: "Run an ad-hoc SELECT query against sessions.db (read-only)",
  },
  args: {
    sql: { type: "positional", description: "SELECT ...", required: true },
    limit: {
      type: "string",
      default: "500",
      description: "Safety cap on rows",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine query",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine sync` + `agentmine normalize` + `agentmine extract`.",
          );
        }
        const sql = String(args.sql ?? "").trim();
        if (!sql) throw Errors.invalidInput("Empty SQL");
        if (!isSelectLike(sql)) {
          throw Errors.invalidInput(NON_SELECT_MESSAGE);
        }
        const limit = toLimit(args.limit, 500);

        const db = openDb({ readonly: true });
        try {
          const stmt = db.prepare(sql);
          const { value: rows, freshness } = readWithFreshnessSnapshot(
            db,
            () => stmt.all() as unknown[],
          );
          const capped = rows.length > limit;
          return {
            data: {
              row_count: rows.length,
              truncated: capped,
              limit,
              rows: capped ? rows.slice(0, limit) : rows,
            },
            warnings: readCommandWarnings(db, freshness),
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw Errors.invalidInput(buildSqlErrorMessage(db, sql, message));
        } finally {
          db.close();
        }
      },
    });
  },
});

// --- S1: read-only statement guardrails -----------------------------------

/**
 * Read-only introspection pragmas that reveal schema shape without any write
 * risk on a connection already opened `readonly: true`. Assignment forms
 * (`PRAGMA x = y`) and any pragma outside this list stay rejected.
 */
export const READONLY_PRAGMAS: ReadonlySet<string> = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
  "database_list",
  "collation_list",
  "function_list",
  "pragma_list",
  "compile_options",
  "freelist_count",
  "page_count",
  "page_size",
  "user_version",
  "schema_version",
  "integrity_check",
  "quick_check",
]);

const PRAGMA_STATEMENT_RE =
  /^pragma\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^;]*\))?\s*;?\s*$/i;

function isSelectStatementPrefix(lowerTrimmed: string): boolean {
  return (
    lowerTrimmed.startsWith("select ") ||
    lowerTrimmed.startsWith("select\n") ||
    lowerTrimmed.startsWith("with ") ||
    lowerTrimmed.startsWith("explain ")
  );
}

/**
 * True for an allowlisted, read-only introspection `PRAGMA <name>[(...)]`.
 *
 * The pattern is anchored, so a chained `PRAGMA table_info(x); ...` fails to
 * match and is rejected. The `=` test rejects the assignment form.
 */
export function isAllowedIntrospectionPragma(sql: string): boolean {
  const trimmed = sql.trim();
  if (trimmed.includes("=")) return false;
  const match = PRAGMA_STATEMENT_RE.exec(trimmed);
  if (!match) return false;
  return READONLY_PRAGMAS.has(match[1]!.toLowerCase());
}

/**
 * True when `sql` is a statement Agentmine's readonly connection may run.
 *
 * There is deliberately no statement-chaining check on the SELECT path.
 * `prepare()` compiles only the first statement and never executes what
 * follows, and the connection is opened read-only, so a trailing statement is
 * inert. Scanning for one would mean lexing SQL well enough to know that the
 * `;` in `cmd_full LIKE '%;%'` is data — a real query that must keep working.
 */
export function isSelectLike(sql: string): boolean {
  const trimmed = sql.trim();
  if (isSelectStatementPrefix(trimmed.toLowerCase())) return true;
  return isAllowedIntrospectionPragma(trimmed);
}

function toLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10000) return fallback;
  return n;
}

// --- S3: derived output fields are not columns ------------------------------

/**
 * Output fields `agentmine sessions` / `agentmine workflows` compute and emit
 * but never store as columns. Checked before the nearest-match search: a
 * fuzzy match against these names would otherwise point at an unrelated
 * column instead of naming the real underlying one (or the lack of one).
 */
export const DERIVED_FIELD_HINTS: Record<string, string> = {
  started_at_iso:
    "`started_at_iso` is a derived output field of `agentmine sessions`/`workflows`, not a column. The column is `sessions.started_at` (epoch seconds); use `datetime(started_at,'unixepoch')` for an ISO string.",
  ended_at_iso:
    "`ended_at_iso` is a derived output field of `agentmine sessions`, not a column. The column is `sessions.ended_at` (epoch seconds); use `datetime(ended_at,'unixepoch')` for an ISO string.",
  first_user_prompt_preview:
    "`first_user_prompt_preview` is a derived output field of `agentmine sessions`, not a column. The column is `sessions.first_user_prompt`.",
  reconstruct_command:
    "`reconstruct_command` is a derived output field of `agentmine sessions`, not a column — there is no underlying column for it.",
};

// --- M2: nearest-match suggestions for "no such column/table" --------------

const NO_SUCH_COLUMN_RE = /no such column:\s*(\S+)/i;
const NO_SUCH_TABLE_RE = /no such table:\s*(\S+)/i;

const NameRowSchema = z.object({ name: z.string() });

interface NearestCandidate {
  label: string;
  distance: number;
}

/** Minimal Levenshtein distance between two strings (insert/delete/substitute = 1). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prevRow = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const currRow = new Array<number>(n + 1);
    currRow[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1]! + 1,
        prevRow[j]! + 1,
        prevRow[j - 1]! + cost,
      );
    }
    prevRow = currRow;
  }
  return prevRow[n]!;
}

function splitQualifier(name: string): {
  qualifier: string | null;
  column: string;
} {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return { qualifier: null, column: name };
  return { qualifier: name.slice(0, dot), column: name.slice(dot + 1) };
}

/** Table/view names visible through `agentmine schema --tables`. */
function listIntrospectableTables(db: DatabaseType): string[] {
  const rows = NameRowSchema.array().parse(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
      .all(),
  );
  return rows
    .map((row) => row.name)
    .filter(
      (name) =>
        !name.startsWith("sqlite_") &&
        !/^messages_fts_(config|data|docsize|idx)$/.test(name),
    );
}

function listColumns(db: DatabaseType, table: string): string[] {
  const rows = NameRowSchema.array().parse(
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table),
  );
  return rows.map((row) => row.name);
}

/** Map a `qualifier.column` reference's qualifier back to a real table name via alias. */
function resolveQualifierToTable(
  qualifier: string,
  sql: string,
  tables: readonly string[],
): string | null {
  const lowerQualifier = qualifier.toLowerCase();
  const direct = tables.find((t) => t.toLowerCase() === lowerQualifier);
  if (direct) return direct;

  const aliasRe =
    /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(?:as\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  for (const match of sql.matchAll(aliasRe)) {
    const tableName = match[1]!;
    const alias = match[2]!;
    if (alias.toLowerCase() === lowerQualifier) {
      const resolved = tables.find(
        (t) => t.toLowerCase() === tableName.toLowerCase(),
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

/** Real table names mentioned in a `FROM`/`JOIN` clause of the failing SQL. */
function detectReferencedTables(
  sql: string,
  tables: readonly string[],
): string[] {
  const found: string[] = [];
  const re = /\b(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  for (const match of sql.matchAll(re)) {
    const tableName = match[1]!;
    const resolved = tables.find(
      (t) => t.toLowerCase() === tableName.toLowerCase(),
    );
    if (resolved && !found.includes(resolved)) found.push(resolved);
  }
  return found;
}

function nearestColumns(
  db: DatabaseType,
  rawColumnName: string,
  sql: string,
): NearestCandidate[] {
  const { qualifier, column } = splitQualifier(rawColumnName);
  const tables = listIntrospectableTables(db);

  let scopeTables: string[] = [];
  if (qualifier) {
    const resolved = resolveQualifierToTable(qualifier, sql, tables);
    if (resolved) scopeTables = [resolved];
  }
  if (scopeTables.length === 0) {
    scopeTables = detectReferencedTables(sql, tables);
  }
  const scoped = scopeTables.length > 0;
  if (!scoped) scopeTables = tables;

  const candidates: NearestCandidate[] = [];
  for (const table of scopeTables) {
    for (const col of listColumns(db, table)) {
      candidates.push({
        label: `${table}.${col}`,
        distance: editDistance(column.toLowerCase(), col.toLowerCase()),
      });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  // A table actually named in the failing SQL is a trustworthy scope on its
  // own — no extra distance gate needed. An unscoped, corpus-wide search
  // needs one, so an unrelated column from a far-away table never gets
  // reported as a match.
  const maxDistance = Math.max(3, Math.ceil(column.length / 3));
  const bounded = scoped
    ? candidates
    : candidates.filter((c) => c.distance <= maxDistance);
  return bounded.slice(0, 3);
}

function nearestTables(
  db: DatabaseType,
  rawTableName: string,
): NearestCandidate[] {
  const tables = listIntrospectableTables(db);
  const maxDistance = Math.max(3, Math.ceil(rawTableName.length / 3));
  return tables
    .map((table) => ({
      label: table,
      distance: editDistance(rawTableName.toLowerCase(), table.toLowerCase()),
    }))
    .filter((c) => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
}

function buildColumnSuggestion(
  db: DatabaseType,
  rawName: string,
  sql: string,
): string {
  const { column } = splitQualifier(rawName);
  const derivedHint = DERIVED_FIELD_HINTS[column];
  if (derivedHint) return derivedHint;

  try {
    const nearest = nearestColumns(db, rawName, sql);
    if (nearest.length === 0) {
      return `No close column match found. ${SCHEMA_DISCOVERY_HINT}`;
    }
    const topLabel = nearest[0]!.label;
    const table = topLabel.slice(0, topLabel.indexOf("."));
    const list = nearest.map((c) => c.label).join(", ");
    return `Did you mean: ${list}? Run \`agentmine schema --table=${table}\` to list columns.`;
  } catch {
    // Schema introspection failed — never let that mask the original SQL error.
    return SCHEMA_DISCOVERY_HINT;
  }
}

function buildTableSuggestion(db: DatabaseType, rawName: string): string {
  try {
    const nearest = nearestTables(db, rawName);
    if (nearest.length === 0) {
      return `No close table match found. ${SCHEMA_DISCOVERY_HINT}`;
    }
    const list = nearest.map((c) => c.label).join(", ");
    return `Did you mean: ${list}? ${SCHEMA_DISCOVERY_HINT}`;
  } catch {
    return SCHEMA_DISCOVERY_HINT;
  }
}

function buildSqlErrorMessage(
  db: DatabaseType,
  sql: string,
  message: string,
): string {
  const columnMatch = NO_SUCH_COLUMN_RE.exec(message);
  if (columnMatch) {
    return `SQL error: ${message} ${buildColumnSuggestion(db, columnMatch[1]!, sql)}`;
  }
  const tableMatch = NO_SUCH_TABLE_RE.exec(message);
  if (tableMatch) {
    return `SQL error: ${message} ${buildTableSuggestion(db, tableMatch[1]!)}`;
  }
  return `SQL error: ${message}`;
}
