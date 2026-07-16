import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";

/**
 * Cross-process advisory write lock for `sessions.db`.
 *
 * agentmine's write commands (`normalize`, `extract`, `embed`) run as separate
 * OS processes, and they overlap in practice: a SessionStart hook fires
 * `normalize --since 1d` while a scheduled `ingest` is mid-run, or two `ingest`
 * runs race. SQLite's WAL mode serializes individual writes, but our batched,
 * read-then-write transactions can still surface `SQLITE_BUSY_SNAPSHOT` to a
 * concurrent writer — a case `busy_timeout` does NOT retry. This lock serializes
 * whole write commands so only one agentmine writer touches the corpus at a
 * time, which also avoids two processes redundantly parsing the same archives.
 *
 * The lock is a single file at `${dbPath}.lock` created with O_EXCL. A holder
 * that crashes leaves a stale file; we reclaim it only when the recorded PID is
 * dead on this host (never steal from a live local holder), or — for the
 * implausible cross-host case — when it is older than `staleMs`.
 */

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_STALE_MS = 60 * 60_000; // 1h — safely above any real write duration
const POLL_INTERVAL_MS = 100;
const WAIT_ENV = "AGENTMINE_LOCK_TIMEOUT_MS";

const writeLockInfoSchema = z.object({
  pid: z.number(),
  host: z.string(),
  command: z.string(),
  acquiredAt: z.number(),
});

export type WriteLockInfo = z.infer<typeof writeLockInfoSchema>;

export interface WriteLockOptions {
  /** Identifies the holder in diagnostics and the lock file. */
  command: string;
  /** Override DB path; the lock lives at `${dbPath}.lock`. Default: getDbPath(). */
  dbPath?: string;
  /** Max ms to wait for a held lock before failing. Default 60s ($AGENTMINE_LOCK_TIMEOUT_MS). */
  waitMs?: number;
  /** A cross-host lock older than this (ms) is treated as abandoned. Default 1h. */
  staleMs?: number;
}

export interface WriteLock {
  readonly path: string;
  release(): void;
}

/** Path of the advisory lock file for a given (or the configured) DB path. */
export function lockPathFor(dbPath?: string): string {
  return `${dbPath ?? getDbPath()}.lock`;
}

function resolveWaitMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(process.env[WAIT_ENV]);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_WAIT_MS;
}

function readMeta(path: string): WriteLockInfo | null {
  try {
    const result = writeLockInfoSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** The errno `code` of a Node error, without an `as` cast. */
function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) {
    const { code } = err;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** True if a PID is live on this host. A signal-0 EPERM means it exists. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

/**
 * Decide whether an existing lock file may be reclaimed. Same-host locks are
 * stolen only when their PID is dead — never from a live local holder, however
 * long it has run. A corrupt file (null meta) is always stealable.
 */
function isStale(meta: WriteLockInfo | null, staleMs: number): boolean {
  if (meta === null) return true;
  if (meta.host === hostname()) return !pidAlive(meta.pid);
  return Date.now() - meta.acquiredAt > staleMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the advisory write lock, waiting up to `waitMs` for a live holder to
 * release it. Throws a retryable `LOCKED` error on timeout. Always pair with
 * `release()` (prefer {@link withWriteLock}).
 */
export async function acquireWriteLock(
  options: WriteLockOptions,
): Promise<WriteLock> {
  const path = lockPathFor(options.dbPath);
  const waitMs = resolveWaitMs(options.waitMs);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const meta: WriteLockInfo = {
    pid: process.pid,
    host: hostname(),
    command: options.command,
    acquiredAt: Date.now(),
  };
  const payload = JSON.stringify(meta);

  mkdirSync(dirname(path), { recursive: true });

  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
      return makeHandle(path, payload);
    } catch (err) {
      if (errorCode(err) !== "EEXIST") {
        const message = err instanceof Error ? err.message : String(err);
        throw Errors.ioError(
          `Failed to acquire agentmine write lock: ${message}`,
          path,
        );
      }
      const holder = readMeta(path);
      if (isStale(holder, staleMs)) {
        reportProgressImmediate("db.lock.reclaim", {
          path,
          stale_pid: holder?.pid ?? null,
          stale_host: holder?.host ?? null,
        });
        try {
          unlinkSync(path);
        } catch {
          // Another waiter reclaimed it first; loop and retry the create.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        const who = holder
          ? `pid ${holder.pid} on ${holder.host} (command "${holder.command}")`
          : "another process";
        throw Errors.locked(
          `Another agentmine write is in progress: ${who}. Waited ${waitMs}ms for ` +
            `${path}. Retry shortly, or raise ${WAIT_ENV}.`,
        );
      }
      reportProgressImmediate("db.lock.wait", {
        path,
        holder_pid: holder?.pid ?? null,
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

function makeHandle(path: string, ownPayload: string): WriteLock {
  let released = false;
  const onExit = (): void => {
    if (!released) tryUnlinkOwn(path, ownPayload);
  };
  process.once("exit", onExit);
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      process.removeListener("exit", onExit);
      tryUnlinkOwn(path, ownPayload);
    },
  };
}

/** Remove the lock file only if it still holds our payload (don't clobber a reclaim). */
function tryUnlinkOwn(path: string, ownPayload: string): void {
  try {
    if (readFileSync(path, "utf8") === ownPayload) unlinkSync(path);
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}

/**
 * Run `fn` while holding the write lock, releasing it even if `fn` throws.
 * The canonical way for a write command to serialize against other writers.
 */
export async function withWriteLock<T>(
  options: WriteLockOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const lock = await acquireWriteLock(options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
