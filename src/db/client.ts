import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import { SCHEMA_SQL } from "./schemaText.js";
import { Database } from "./sqlite.js";

type DatabaseType = Database;

const SCHEMA_VERSION = "14";
export const CODEX_LINEAGE_BACKFILL_META_KEY = "codex_lineage_backfill_pending";

/** Defensive busy timeout (ms); generous vs. our short transactions. See db/lock.ts. */
const BUSY_TIMEOUT_MS = 15_000;

export interface OpenDbOptions {
  readonly?: boolean;
  /** If true, create/open and apply schema if missing. Default true (non-readonly). */
  init?: boolean;
  /** Override DB path. Default: config.getDbPath(). */
  path?: string;
}

export function dbExists(path?: string): boolean {
  const p = path ?? getDbPath();
  try {
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

export function openDb(opts: OpenDbOptions = {}): DatabaseType {
  const path = opts.path ?? getDbPath();
  const readonly = opts.readonly ?? false;
  const init = opts.init ?? !readonly;

  if (!readonly) {
    mkdirSync(dirname(path), { recursive: true });
  } else if (!existsSync(path)) {
    throw Errors.notFound(
      `Database not found at ${path}. Run \`agentmine normalize\` first.`,
    );
  }

  const db = new Database(path, { readonly });
  db.pragma("journal_mode = WAL");
  // Defensive: whole-command serialization lives in db/lock.ts, but if a writer
  // ever slips through, wait for a contended write rather than failing instantly
  // with SQLITE_BUSY. Transactions here are short (per-batch / per-extractor).
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  if (init && !readonly) {
    applySchema(db);
    applyDataMigrations(db);
    upsertMeta(db, "schema_version", SCHEMA_VERSION);
  }

  return db;
}

function applyDataMigrations(db: DatabaseType): void {
  const storedVersion = Number.parseInt(
    getMeta(db, "schema_version") ?? "0",
    10,
  );
  const currentVersion = Number.isSafeInteger(storedVersion)
    ? storedVersion
    : 0;

  if (currentVersion < 14 && tableExists(db, "sessions")) {
    const legacyCodexSessions =
      db
        .prepare<[], { count: number }>(
          `SELECT COUNT(*) AS count FROM sessions WHERE source = 'codex'`,
        )
        .get()?.count ?? 0;
    if (legacyCodexSessions === 0) return;

    // Before canonical Codex lineage support, the parser copied the client
    // originator (for example, `codex-tui`) into agent_type for every session.
    // agent_type now classifies only children; roots intentionally leave it
    // unset, matching the Claude Code canonical shape.
    db.prepare(
      `UPDATE sessions
          SET agent_type = NULL
        WHERE source = 'codex'
          AND parent_session_id IS NULL
          AND agent_type IS NOT NULL`,
    ).run();

    // Canonical content hashes intentionally cover transcript content rather
    // than session metadata. Invalidate the old Codex cache entries once so a
    // routine post-upgrade normalize/ingest reparses the active mirror and
    // fills parent_session_id plus semantic child agent_type values.
    db.prepare(
      `UPDATE sessions
          SET content_hash = NULL
        WHERE source = 'codex'`,
    ).run();
    upsertMeta(db, CODEX_LINEAGE_BACKFILL_META_KEY, "1");
  }
}

function applySchema(db: DatabaseType): void {
  // Run additive ALTERs BEFORE the schema SQL so that any indexes the
  // schema SQL declares on those columns can be created without error.
  if (tableExists(db, "sessions")) {
    addColumnIfMissing(
      db,
      "sessions",
      "ended_with_commit_attempted",
      "INTEGER",
    );
    addColumnIfMissing(db, "sessions", "agent_type", "TEXT");
    // Schema v6: token breakdown + abort tracking.
    addColumnIfMissing(db, "sessions", "cache_read_tokens", "INTEGER");
    addColumnIfMissing(db, "sessions", "cache_creation_tokens", "INTEGER");
    addColumnIfMissing(db, "sessions", "reasoning_tokens", "INTEGER");
    addColumnIfMissing(db, "sessions", "aborted_turns", "INTEGER DEFAULT 0");
  }
  // Schema v7: LLM-classified columns on the heuristic tables.
  if (tableExists(db, "tool_errors")) {
    addColumnIfMissing(db, "tool_errors", "error_category_llm", "TEXT");
    addColumnIfMissing(db, "tool_errors", "error_category_llm_source", "TEXT");
  }
  if (tableExists(db, "user_corrections")) {
    addColumnIfMissing(db, "user_corrections", "kind_llm", "TEXT");
    addColumnIfMissing(db, "user_corrections", "kind_llm_source", "TEXT");
  }
  if (tableExists(db, "friction_events")) {
    addColumnIfMissing(db, "friction_events", "type_llm", "TEXT");
    addColumnIfMissing(db, "friction_events", "type_llm_source", "TEXT");
  }
  // Schema v11: per-message token usage. Mirrors the session-level breakdown
  // so a skill-invocation span can be summed message-by-message.
  if (tableExists(db, "messages")) {
    addColumnIfMissing(db, "messages", "input_tokens", "INTEGER");
    addColumnIfMissing(db, "messages", "output_tokens", "INTEGER");
    addColumnIfMissing(db, "messages", "cache_read_tokens", "INTEGER");
    addColumnIfMissing(db, "messages", "cache_creation_tokens", "INTEGER");
    addColumnIfMissing(db, "messages", "reasoning_tokens", "INTEGER");
  }
  runMultiStatementSql(db, SCHEMA_SQL);
}

function tableExists(db: DatabaseType, table: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    )
    .get(table);
  return Boolean(row);
}

function addColumnIfMissing(
  db: DatabaseType,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  }
}

/** Apply a multi-statement SQL string. Wrapper around the SQLite batch API. */
export function runMultiStatementSql(db: DatabaseType, sql: string): void {
  db.execBatch(sql);
}

export function upsertMeta(db: DatabaseType, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getMeta(db: DatabaseType, key: string): string | undefined {
  const row = db
    .prepare<[string], { value: string }>(
      `SELECT value FROM meta WHERE key = ?`,
    )
    .get(key);
  return row?.value;
}

export type { Statement } from "./sqlite.js";
export type { DatabaseType };
