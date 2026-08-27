/**
 * Making silence legible.
 *
 * A daemon that has stopped importing and a machine with nothing to import look
 * identical from outside: no output, no errors, a process that is still there.
 * The silent failure is the one that matters, because every consumer downstream
 * keeps reading a corpus that has quietly stopped advancing and has no way to
 * tell.
 *
 * So progress is recorded in the corpus itself, next to the stage watermarks
 * that corpus freshness already exposes. Liveness is then answerable from the
 * corpus alone, without inspecting the process table — which matters because
 * the reader is usually somewhere else entirely.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { paths } from "../config.js";
import { type DatabaseType, upsertMeta } from "../db/client.js";
import {
  clearStandDown,
  DAEMON_HEARTBEAT_META_KEY,
  DAEMON_STARTED_META_KEY,
  recordStandDown,
  type StandDownReason,
} from "../db/supervision.js";
import { removeOwnedLockFile, tryCreateLockFile } from "../lock-file.js";

export { DAEMON_HEARTBEAT_META_KEY, DAEMON_STARTED_META_KEY };

export function recordDaemonHeartbeat(db: DatabaseType, at: Date): void {
  upsertMeta(db, DAEMON_HEARTBEAT_META_KEY, at.toISOString());
}

/**
 * A starting daemon clears any recorded stand-down, so the reason on file
 * always describes why the daemon that is *currently* absent left — not one
 * from two restarts ago, which would be read as a live diagnosis of a healthy
 * machine.
 */
export function recordDaemonStart(db: DatabaseType, at: Date): void {
  upsertMeta(db, DAEMON_STARTED_META_KEY, at.toISOString());
  clearStandDown(db);
}

/** Leave the reason behind before exiting, so the restart is explicable. */
export function recordDaemonStandDown(
  db: DatabaseType,
  reason: StandDownReason,
  detail: string,
  at: Date,
): void {
  recordStandDown(db, { reason, detail, at: at.toISOString() });
}

const lockFileSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});

function lockPath(): string {
  return join(paths.sessionsRoot, "daemon.lock");
}

export interface LockOutcome {
  acquired: boolean;
  /** Exact lock path for diagnostics and explicit stale recovery. */
  path: string;
  /** Set when refused: the pid already holding the corpus. */
  heldByPid?: number;
  /** False when a present lock did not contain trustworthy ownership. */
  ownershipKnown?: boolean;
}

interface DaemonLockSnapshot {
  payload: string;
  owner: z.infer<typeof lockFileSchema> | null;
}

let ownedDaemonLock: { path: string; payload: string } | undefined;

/**
 * Refuse a second daemon against one corpus.
 *
 * Concurrent daemons cannot corrupt anything — writers already serialize on the
 * corpus write lock — but they double the cost for no benefit. Existing locks
 * fail closed. Automatically reclaiming a lock after a PID-only
 * liveness check is unsafe because PIDs can be reused, and compare-then-delete
 * can remove a newer owner's lock. Recovery therefore requires stopping every
 * possible daemon and removing the exact lock path explicitly.
 */
export async function acquireDaemonLock(
  now: Date,
  pathOverride?: string,
): Promise<LockOutcome> {
  const path = pathOverride ?? lockPath();
  const payload = `${JSON.stringify(
    { pid: process.pid, startedAt: now.toISOString() },
    null,
    2,
  )}\n`;
  mkdirSync(dirname(path), { recursive: true });

  if (tryCreateLockFile(path, payload)) {
    ownedDaemonLock = { path, payload };
    return { acquired: true, path, ownershipKnown: true };
  }
  const existing = readLock(path);
  if (existing === undefined || existing.owner === null) {
    return { acquired: false, path, ownershipKnown: false };
  }
  return {
    acquired: false,
    path,
    heldByPid: existing.owner.pid,
    ownershipKnown: true,
  };
}

export function releaseDaemonLock(): void {
  const owned = ownedDaemonLock;
  if (owned === undefined) return;
  const removal = removeOwnedLockFile(owned.path, owned.payload);
  if (removal === "changed") {
    throw new Error(
      `Refusing to release the Agentmine daemon lock because its ownership payload changed: ${owned.path}`,
    );
  }
  ownedDaemonLock = undefined;
}

function readLock(path: string): DaemonLockSnapshot | undefined {
  try {
    const payload = readFileSync(path, "utf8");
    const parsed = lockFileSchema.safeParse(JSON.parse(payload));
    return { payload, owner: parsed.success ? parsed.data : null };
  } catch {
    return undefined;
  }
}
