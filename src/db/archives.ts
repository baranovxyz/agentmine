/**
 * Sibling payload archives.
 *
 * The hot database holds only what queries read. Verbatim source events and
 * full tool output live in sibling archive databases that are attached only by
 * the commands that actually touch payload, so a hot-only command's cost is
 * bounded by the hot database alone.
 *
 * Atomicity note: a transaction spanning attached databases is NOT atomic
 * while the main database uses WAL. Callers must therefore rely on the
 * cold-first write ordering documented in `db/writer.ts`, never on a shared
 * transaction.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { getDbPath } from "../config.js";
import type { DatabaseType } from "./client.js";
import { assertPayloadCodecAvailable } from "./payloadCodec.js";

export const ArchiveKindSchema = z.enum(["raw", "tools"]);
export type ArchiveKind = z.infer<typeof ArchiveKindSchema>;

/** SQLite schema alias each archive is attached under. */
const SCHEMA_ALIAS: Record<ArchiveKind, string> = {
  raw: "archive_raw",
  tools: "archive_tools",
};

/** Filename suffix each archive takes beside the hot database. */
const FILE_SUFFIX: Record<ArchiveKind, string> = {
  raw: "-raw.db",
  tools: "-tools.db",
};

const ARCHIVE_SCHEMA: Record<ArchiveKind, (alias: string) => string> = {
  raw: (alias) => `
    CREATE TABLE IF NOT EXISTS ${alias}.raw_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT,
      ts INTEGER,
      payload BLOB NOT NULL,
      PRIMARY KEY(session_id, seq)
    );
  `,
  tools: (alias) => `
    CREATE TABLE IF NOT EXISTS ${alias}.tool_outputs (
      session_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      idx INTEGER NOT NULL,
      payload BLOB NOT NULL,
      PRIMARY KEY(session_id, turn, idx)
    );
  `,
};

/** Schema alias an attached archive is addressed by in SQL. */
export function archiveAlias(kind: ArchiveKind): string {
  return SCHEMA_ALIAS[kind];
}

/**
 * Resolve an archive's path from the hot database path, so an
 * `AGENTMINE_DB` override moves the archives with it instead of stranding
 * them beside a database nobody is using.
 */
export function archivePath(kind: ArchiveKind, dbPath = getDbPath()): string {
  const dir = dirname(dbPath);
  const file = basename(dbPath);
  const stem = file.endsWith(".db") ? file.slice(0, -".db".length) : file;
  return join(dir, `${stem}${FILE_SUFFIX[kind]}`);
}

export function archiveExists(kind: ArchiveKind, dbPath?: string): boolean {
  return existsSync(archivePath(kind, dbPath));
}

/**
 * The file backing this connection's `main` schema.
 *
 * Archives are siblings of the database actually open, not of whatever
 * `getDbPath()` currently resolves to — otherwise a connection opened on an
 * explicit path would attach the wrong corpus's archives.
 */
export function mainDbPath(db: DatabaseType): string | undefined {
  const rows = db.pragma("database_list");
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record: Record<string, unknown> = { ...row };
    if (record.name !== "main") continue;
    const file = record.file;
    return typeof file === "string" && file.length > 0 ? file : undefined;
  }
  return undefined;
}

export interface AttachOptions {
  /** Create the archive file and its schema when missing. Requires a writable connection. */
  create?: boolean;
  /** Override the hot database path used to derive the archive location. */
  dbPath?: string;
}

/**
 * Attach one archive to an open connection. Returns the schema alias to
 * qualify payload tables with. Attaching is idempotent within a connection.
 */
export function attachArchive(
  db: DatabaseType,
  kind: ArchiveKind,
  options: AttachOptions = {},
): string {
  const alias = SCHEMA_ALIAS[kind];
  if (isAttached(db, alias)) return alias;

  const path = archivePath(kind, options.dbPath ?? mainDbPath(db));
  if (!options.create && !existsSync(path)) {
    throw new Error(
      `Payload archive not found at ${path}. Run \`agentmine compact\` to migrate this corpus to the split storage layout.`,
    );
  }
  if (options.create) assertPayloadCodecAvailable();

  db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(path);

  if (options.create) {
    db.pragma(`${alias}.journal_mode = WAL`);
    db.pragma(`${alias}.synchronous = NORMAL`);
    db.execBatch(ARCHIVE_SCHEMA[kind](alias));
  }
  return alias;
}

/**
 * Attach an archive only if its file already exists. Read paths use this so a
 * corpus that has never ingested payload (no archive yet) reads as empty
 * instead of failing.
 */
export function attachArchiveIfPresent(
  db: DatabaseType,
  kind: ArchiveKind,
  dbPath?: string,
): boolean {
  const resolved = dbPath ?? mainDbPath(db);
  if (!archiveExists(kind, resolved)) return false;
  attachArchive(db, kind, { dbPath: resolved });
  return true;
}

export function detachArchive(db: DatabaseType, kind: ArchiveKind): void {
  const alias = SCHEMA_ALIAS[kind];
  if (!isAttached(db, alias)) return;
  db.prepare(`DETACH DATABASE ${alias}`).run();
}

export const CorpusLayoutSchema = z.enum(["split", "pre-split"]);
export type CorpusLayout = z.infer<typeof CorpusLayoutSchema>;

/**
 * Which storage layout a corpus is in. A corpus is either fully migrated or
 * fully unmigrated, so commands branch once here instead of probing both
 * layouts on every read.
 *
 * Presence of the pre-split payload tables in the hot database is the marker:
 * `agentmine compact` drops them as its final step, and the schema no longer
 * declares them, so they can never reappear.
 */
export function corpusLayout(db: DatabaseType): CorpusLayout {
  const row = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type = 'table' AND name IN ('raw_events', 'tool_outputs')`,
    )
    .get();
  return (row?.n ?? 0) > 0 ? "pre-split" : "split";
}

export function isAttached(db: DatabaseType, alias: string): boolean {
  const rows = db.pragma("database_list");
  if (!Array.isArray(rows)) return false;
  return rows.some(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      "name" in row &&
      (row as { name: unknown }).name === alias,
  );
}
