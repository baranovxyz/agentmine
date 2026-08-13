import { statfsSync, statSync } from "node:fs";
import { defineCommand } from "citty";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import {
  reportProgress,
  reportProgressImmediate,
} from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import {
  archiveAlias,
  archivePath,
  attachArchive,
  corpusLayout,
} from "../db/archives.js";
import {
  type DatabaseType,
  dbExists,
  getMeta,
  openDb,
  upsertMeta,
} from "../db/client.js";
import { withWriteLock } from "../db/lock.js";
import { encodePayload } from "../db/payloadCodec.js";

/** Last session id whose payload has been fully relocated, for resume. */
const WATERMARK_META_KEY = "compact_watermark";

/** Sessions per relocation batch. Bounds transaction size and memory. */
const BATCH = 25;

/** Rows sampled per payload table when estimating compressed size. */
const SAMPLE_ROWS = 750;

/**
 * Headroom over the estimate before the command agrees to start. The estimate
 * is sampled rather than exact, and SQLite needs scratch space of its own.
 */
const SAFETY_FACTOR = 1.25;

/**
 * Free-page share above which an already-split hot database is treated as
 * still needing its space reclaimed.
 */
const BLOATED_FREE_PAGE_RATIO = 0.1;

interface StageEstimate {
  rows: number;
  source_bytes: number;
  estimated_archive_bytes: number;
  sampled_ratio: number | null;
}

interface FileSizes {
  hot_db: number;
  raw_archive: number;
  tools_archive: number;
}

interface SpaceReport {
  required_bytes: number;
  available_bytes: number;
  margin_bytes: number;
  sufficient: boolean;
  safety_factor: number;
}

interface CompactPlan {
  layout: "split" | "pre-split";
  bytes: FileSizes;
  estimate: { raw_events: StageEstimate; tool_outputs: StageEstimate };
  space: SpaceReport;
}

/** One stable receipt shape across dry-run, no-op, and completed migrations. */
interface CompactReceipt extends CompactPlan {
  dry_run: boolean;
  status: "planned" | "completed" | "resumed" | "already-split";
  resumed_from_session: string | null;
  moved_sessions: number;
  bytes_after: FileSizes;
}

function receipt(
  planned: CompactPlan,
  fields: Omit<CompactReceipt, keyof CompactPlan>,
): CompactReceipt {
  return { ...planned, ...fields };
}

export const compactCommand = defineCommand({
  meta: {
    name: "compact",
    description:
      "Relocate verbatim payload out of sessions.db into sibling archive databases, then reclaim the space. Resumable; refuses to start without enough free disk.",
  },
  args: {
    "dry-run": {
      type: "boolean",
      default: false,
      description: "Report the plan and space estimate without writing",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Start even when the free-space estimate says there is not enough room",
    },
  },
  async run({ args }) {
    const dryRun = Boolean(args["dry-run"]);
    await runCommand({
      command: "agentmine compact",
      handler: async () => {
        const dbPath = getDbPath();
        if (!dbExists(dbPath)) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }

        if (dryRun) {
          const db = openDb({
            readonly: true,
            init: false,
            path: dbPath,
            allowPreSplit: true,
          });
          try {
            const planned = plan(db, dbPath);
            return {
              data: receipt(planned, {
                dry_run: true,
                status:
                  planned.layout === "split" ? "already-split" : "planned",
                resumed_from_session: getMeta(db, WATERMARK_META_KEY) || null,
                moved_sessions: 0,
                bytes_after: planned.bytes,
              }),
            };
          } finally {
            db.close();
          }
        }

        reportProgressImmediate("compact.start");
        return await withWriteLock({ command: "agentmine compact" }, () => {
          const db = openDb({ path: dbPath, allowPreSplit: true });
          try {
            const planned = plan(db, dbPath);
            if (!planned.space.sufficient && !args.force) {
              throw Errors.invalidInput(
                `Not enough free disk to compact safely: need about ${gb(planned.space.required_bytes)} GB (estimate plus ${Math.round((SAFETY_FACTOR - 1) * 100)}% headroom), ${gb(planned.space.available_bytes)} GB available. Free space and retry, or pass --force to accept the risk of running out mid-migration.`,
              );
            }
            if (planned.layout === "split") {
              // Already relocated — but the space may still not have been
              // reclaimed. Dropping the payload tables commits before VACUUM
              // runs, so a VACUUM that failed (typically out of disk) leaves a
              // split corpus carrying a large free list. Without this, that
              // state is unrecoverable: every re-run would stop right here.
              const reclaimed = vacuumIfBloated(db);
              return {
                data: receipt(planned, {
                  dry_run: false,
                  status: "already-split",
                  resumed_from_session: null,
                  moved_sessions: 0,
                  bytes_after: reclaimed ? fileSizes(dbPath) : planned.bytes,
                }),
              };
            }

            attachArchive(db, "raw", { create: true, dbPath });
            attachArchive(db, "tools", { create: true, dbPath });

            const resumedFrom = getMeta(db, WATERMARK_META_KEY) ?? null;
            const movedSessions = relocate(db, resumedFrom);

            // Only once every session's payload is in the archives can the hot
            // tables be dropped and the freed pages returned to the filesystem.
            dropLegacyPayloadTables(db);
            upsertMeta(db, WATERMARK_META_KEY, "");
            reportProgressImmediate("compact.vacuum");
            db.execBatch("VACUUM");
            // Under WAL, VACUUM's result lands in the write-ahead log: the main file
            // keeps its old size until a checkpoint truncates it. Force that here so the
            // space is actually returned to the filesystem and the receipt's byte totals
            // describe reality rather than the pre-VACUUM file.
            db.pragma("wal_checkpoint(TRUNCATE)");

            return {
              data: receipt(planned, {
                dry_run: false,
                status: resumedFrom ? "resumed" : "completed",
                resumed_from_session: resumedFrom,
                moved_sessions: movedSessions,
                bytes_after: fileSizes(dbPath),
              }),
            };
          } finally {
            db.close();
          }
        });
      },
    });
  },
});

/** Estimate the migration's cost and whether it can run. */
function plan(db: DatabaseType, dbPath: string): CompactPlan {
  const layout = corpusLayout(db);
  const estimate =
    layout === "pre-split"
      ? {
          raw_events: estimateStage(db, "raw_events", "raw_json"),
          tool_outputs: estimateStage(db, "tool_outputs", "output_text"),
        }
      : {
          raw_events: emptyStage(),
          tool_outputs: emptyStage(),
        };

  const archiveBytes =
    estimate.raw_events.estimated_archive_bytes +
    estimate.tool_outputs.estimated_archive_bytes;
  const payloadBytes =
    estimate.raw_events.source_bytes + estimate.tool_outputs.source_bytes;
  const bytes = fileSizes(dbPath);
  // Peak = archives written alongside an as-yet-unshrunk hot database, plus
  // the compacted copy VACUUM writes before replacing the original.
  const vacuumOutputBytes = Math.max(bytes.hot_db - payloadBytes, 0);
  const requiredBytes = Math.round(
    (archiveBytes + vacuumOutputBytes) * SAFETY_FACTOR,
  );
  const availableBytes = freeBytes(dbPath);

  return {
    layout,
    bytes,
    estimate,
    space: {
      required_bytes: requiredBytes,
      available_bytes: availableBytes,
      margin_bytes: availableBytes - requiredBytes,
      sufficient: availableBytes >= requiredBytes,
      safety_factor: SAFETY_FACTOR,
    },
  };
}

/**
 * Estimate a payload table's archived size by compressing a strided sample
 * with the real codec, so the ratio reflects this corpus rather than a
 * hardcoded assumption.
 */
function estimateStage(
  db: DatabaseType,
  table: string,
  column: string,
): StageEstimate {
  const rows =
    db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()
      ?.n ?? 0;
  if (rows === 0) return emptyStage();

  // Sample by seeking to evenly spaced rowids rather than filtering on a
  // computed expression: `rowid % n = 0` cannot use an index, so on a
  // multi-gigabyte payload table it degrades into the full scan this whole
  // change exists to avoid. Each seek here is an index lookup.
  const bounds = db
    .prepare<[], { lo: number | null; hi: number | null }>(
      `SELECT MIN(rowid) AS lo, MAX(rowid) AS hi FROM ${table}`,
    )
    .get();
  if (!bounds || bounds.lo === null || bounds.hi === null) return emptyStage();

  const seek = db.prepare<[number], { value: string }>(
    `SELECT ${column} AS value FROM ${table} WHERE rowid >= ? ORDER BY rowid LIMIT 1`,
  );
  const span = bounds.hi - bounds.lo + 1;
  const wanted = Math.min(SAMPLE_ROWS, rows);
  const step = Math.max(1, Math.floor(span / wanted));

  let sampled = 0;
  let rawBytes = 0;
  let encodedBytes = 0;
  for (let i = 0; i < wanted; i += 1) {
    const row = seek.get(bounds.lo + i * step);
    if (!row) break;
    rawBytes += Buffer.byteLength(row.value, "utf8");
    encodedBytes += encodePayload(row.value).byteLength;
    sampled += 1;
  }
  if (sampled === 0) return emptyStage();

  const avgRaw = rawBytes / sampled;
  const avgEncoded = encodedBytes / sampled;

  return {
    rows,
    source_bytes: Math.round(avgRaw * rows),
    estimated_archive_bytes: Math.round(avgEncoded * rows),
    sampled_ratio: encodedBytes > 0 ? rawBytes / encodedBytes : null,
  };
}

function emptyStage(): StageEstimate {
  return {
    rows: 0,
    source_bytes: 0,
    estimated_archive_bytes: 0,
    sampled_ratio: null,
  };
}

/**
 * Move payload one batch of sessions at a time, archives first.
 *
 * Ordering is what makes an interrupted run safe: archive rows are committed
 * before the hot rows are deleted, so a crash can only duplicate payload (which
 * the retry overwrites), never lose it. The watermark advances with the hot
 * delete, so a resumed run skips only sessions already fully relocated.
 */
function relocate(db: DatabaseType, resumedFrom: string | null): number {
  const raw = archiveAlias("raw");
  const tools = archiveAlias("tools");
  let after = resumedFrom ?? "";
  let moved = 0;

  for (;;) {
    const batch = db
      .prepare<[string, number], { id: string }>(
        `SELECT id FROM sessions WHERE id > ? ORDER BY id LIMIT ?`,
      )
      .all(after, BATCH);
    if (batch.length === 0) break;

    for (const { id } of batch) {
      // Phase 1: payload into the archives, committed on its own.
      const toArchive = db.transaction(() => {
        db.prepare(`DELETE FROM ${raw}.raw_events WHERE session_id = ?`).run(
          id,
        );
        db.prepare(
          `DELETE FROM ${tools}.tool_outputs WHERE session_id = ?`,
        ).run(id);

        const insertRaw = db.prepare(
          `INSERT INTO ${raw}.raw_events (session_id, seq, source, event_type, ts, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        const rawRows = db
          .prepare<
            [string],
            {
              seq: number;
              source: string;
              event_type: string | null;
              ts: number | null;
              raw_json: string;
            }
          >(
            `SELECT seq, source, event_type, ts, raw_json FROM raw_events WHERE session_id = ?`,
          )
          .all(id);
        for (const row of rawRows) {
          insertRaw.run(
            id,
            row.seq,
            row.source,
            row.event_type,
            row.ts,
            encodePayload(row.raw_json),
          );
        }

        const insertOut = db.prepare(
          `INSERT INTO ${tools}.tool_outputs (session_id, turn, idx, payload)
           VALUES (?, ?, ?, ?)`,
        );
        const outRows = db
          .prepare<
            [string],
            { turn: number; idx: number; output_text: string }
          >(
            `SELECT turn, idx, output_text FROM tool_outputs WHERE session_id = ?`,
          )
          .all(id);
        for (const row of outRows) {
          insertOut.run(id, row.turn, row.idx, encodePayload(row.output_text));
        }
        return { rawCount: rawRows.length, outCount: outRows.length };
      });
      const counts = toArchive();

      // Phase 2: drop the hot copies, record the per-session counters `stats`
      // now reads, and advance the resume watermark — all in one commit.
      const toHot = db.transaction(() => {
        db.prepare(`DELETE FROM raw_events WHERE session_id = ?`).run(id);
        db.prepare(`DELETE FROM tool_outputs WHERE session_id = ?`).run(id);
        db.prepare(
          `UPDATE sessions SET raw_event_count = ?, tool_output_count = ? WHERE id = ?`,
        ).run(counts.rawCount, counts.outCount, id);
        upsertMeta(db, WATERMARK_META_KEY, id);
      });
      toHot();

      after = id;
      moved += 1;
    }
    reportProgress("compact.batch", { moved_sessions: moved });
  }
  return moved;
}

/**
 * Final sweep, then drop the pre-split tables.
 *
 * The per-session pass deletes each session's hot payload as it relocates it,
 * so whatever is still here was never relocated: rows for sessions that no
 * longer exist, and — if a watermark ever over-claims — rows the batch loop
 * skipped. Relocating everything that remains makes the DROP lossless by
 * construction rather than by trusting the watermark.
 */
function dropLegacyPayloadTables(db: DatabaseType): void {
  const raw = archiveAlias("raw");
  const tools = archiveAlias("tools");

  const remainingRaw =
    db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM raw_events`).get()
      ?.n ?? 0;
  const remainingOut =
    db
      .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM tool_outputs`)
      .get()?.n ?? 0;
  if (remainingRaw > 0 || remainingOut > 0) {
    reportProgress("compact.sweep", {
      raw_events: remainingRaw,
      tool_outputs: remainingOut,
    });
  }

  const move = db.transaction(() => {
    const insertRaw = db.prepare(
      `INSERT OR REPLACE INTO ${raw}.raw_events (session_id, seq, source, event_type, ts, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const row of db
      .prepare<
        [],
        {
          session_id: string;
          seq: number;
          source: string;
          event_type: string | null;
          ts: number | null;
          raw_json: string;
        }
      >(
        `SELECT session_id, seq, source, event_type, ts, raw_json FROM raw_events`,
      )
      .all()) {
      insertRaw.run(
        row.session_id,
        row.seq,
        row.source,
        row.event_type,
        row.ts,
        encodePayload(row.raw_json),
      );
    }
    const insertOut = db.prepare(
      `INSERT OR REPLACE INTO ${tools}.tool_outputs (session_id, turn, idx, payload)
       VALUES (?, ?, ?, ?)`,
    );
    for (const row of db
      .prepare<
        [],
        { session_id: string; turn: number; idx: number; output_text: string }
      >(`SELECT session_id, turn, idx, output_text FROM tool_outputs`)
      .all()) {
      insertOut.run(
        row.session_id,
        row.turn,
        row.idx,
        encodePayload(row.output_text),
      );
    }
  });
  move();

  // Backfill counters for any session the batch loop skipped, so `stats`
  // totals stay exact after a resumed run.
  db.prepare(
    `UPDATE sessions SET
       raw_event_count = COALESCE(raw_event_count,
         (SELECT COUNT(*) FROM ${raw}.raw_events r WHERE r.session_id = sessions.id)),
       tool_output_count = COALESCE(tool_output_count,
         (SELECT COUNT(*) FROM ${tools}.tool_outputs t WHERE t.session_id = sessions.id))
     WHERE raw_event_count IS NULL OR tool_output_count IS NULL`,
  ).run();

  db.execBatch(`
    DROP TABLE IF EXISTS raw_events;
    DROP TABLE IF EXISTS tool_outputs;
  `);
}

/**
 * Reclaim space if the hot database is carrying a lot of free pages, which is
 * what an interrupted or failed VACUUM leaves behind. Returns whether it ran.
 */
function vacuumIfBloated(db: DatabaseType): boolean {
  const free = Number(db.pragma("freelist_count", { simple: true }) ?? 0);
  const total = Number(db.pragma("page_count", { simple: true }) ?? 0);
  if (total === 0 || free / total < BLOATED_FREE_PAGE_RATIO) return false;
  reportProgressImmediate("compact.vacuum");
  db.execBatch("VACUUM");
  // Under WAL, VACUUM's result lands in the write-ahead log: the main file
  // keeps its old size until a checkpoint truncates it. Force that here so the
  // space is actually returned to the filesystem and the receipt's byte totals
  // describe reality rather than the pre-VACUUM file.
  db.pragma("wal_checkpoint(TRUNCATE)");
  return true;
}

function fileSizes(dbPath: string): {
  hot_db: number;
  raw_archive: number;
  tools_archive: number;
} {
  return {
    hot_db: sizeOf(dbPath),
    raw_archive: sizeOf(archivePath("raw", dbPath)),
    tools_archive: sizeOf(archivePath("tools", dbPath)),
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function freeBytes(dbPath: string): number {
  try {
    const fs = statfsSync(dbPath);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return 0;
  }
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}
