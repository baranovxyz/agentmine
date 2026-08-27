import { mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { removeOwnedLockFile, tryCreateLockFile } from "../lock-file.js";

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
 * The lock is a single file at `${dbPath}.lock`, published atomically only after
 * its ownership payload is complete. Existing locks always fail closed: a
 * process cannot safely compare and delete one lock generation atomically while
 * another process may publish the next generation. Stale recovery is therefore
 * an explicit operator action after every possible holder has been stopped.
 */

const DEFAULT_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const WAIT_PROGRESS_INTERVAL_MS = 5_000;
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
  /** Max ms to wait for a held lock before failing. Default 5s ($AGENTMINE_LOCK_TIMEOUT_MS). */
  waitMs?: number;
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
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }
  const fromEnv = Number(process.env[WAIT_ENV]);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : DEFAULT_WAIT_MS;
}

interface LockSnapshot {
  payload: string;
  holder: WriteLockInfo | null;
}

function readSnapshot(path: string): LockSnapshot | undefined {
  try {
    const payload = readFileSync(path, "utf8");
    const result = writeLockInfoSchema.safeParse(JSON.parse(payload));
    return { payload, holder: result.success ? result.data : null };
  } catch {
    return undefined;
  }
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
  const meta: WriteLockInfo = {
    pid: process.pid,
    host: hostname(),
    command: options.command,
    acquiredAt: Date.now(),
  };
  const payload = JSON.stringify(meta);

  mkdirSync(dirname(path), { recursive: true });

  const deadline = Date.now() + waitMs;
  const waitStartedAt = Date.now();
  let lastWaitProgressAt: number | undefined;
  for (;;) {
    try {
      if (tryCreateLockFile(path, payload)) return makeHandle(path, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw Errors.ioError(
        `Failed to acquire agentmine write lock: ${message}`,
        path,
      );
    }
    const holder = readSnapshot(path)?.holder ?? null;
    if (Date.now() >= deadline) {
      const who = holder
        ? `pid ${holder.pid} on ${holder.host} (command "${holder.command}")`
        : "another process with unreadable ownership metadata";
      throw Errors.locked(
        `Another agentmine write is in progress: ${who}. Waited ${waitMs}ms for ` +
          `${path}. Retry shortly, or raise ${WAIT_ENV}. If the owner exited ` +
          `without releasing the lock, stop all Agentmine writers, verify that ` +
          `none remain, and remove exactly ${path}.`,
      );
    }
    const now = Date.now();
    if (
      lastWaitProgressAt === undefined ||
      now - lastWaitProgressAt >= WAIT_PROGRESS_INTERVAL_MS
    ) {
      lastWaitProgressAt = now;
      reportProgressImmediate("db.lock.wait", {
        path,
        holder_pid: holder?.pid ?? null,
        holder_command: holder?.command ?? null,
        holder_acquired_at: holder?.acquiredAt ?? null,
        waited_ms: now - waitStartedAt,
        timeout_ms: Number.isFinite(waitMs) ? waitMs : null,
      });
    }
    await sleep(POLL_INTERVAL_MS);
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
      process.removeListener("exit", onExit);
      try {
        const removal = removeOwnedLockFile(path, ownPayload);
        if (removal === "changed") {
          throw Errors.ioError(
            "Refusing to release the Agentmine write lock because its ownership payload changed. Stop all writers and inspect the exact lock path before recovery.",
            path,
          );
        }
        released = true;
      } catch (error) {
        process.once("exit", onExit);
        if (error instanceof Error && "cliName" in error) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw Errors.ioError(
          `Failed to release the Agentmine write lock: ${message}`,
          path,
        );
      }
    },
  };
}

/** A cooperating process cannot replace this lock because reclaim is manual. */
function tryUnlinkOwn(path: string, ownPayload: string): void {
  try {
    removeOwnedLockFile(path, ownPayload);
  } catch {
    // Process exit cannot recover or report through the CLI result contract.
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
