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
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  /** Set when refused: the pid already holding the corpus. */
  heldByPid?: number;
}

/**
 * Refuse a second daemon against one corpus.
 *
 * Concurrent daemons cannot corrupt anything — writers already serialize on the
 * corpus write lock — but they double the cost for no benefit. A lock left by a
 * crashed process is reclaimed: the recorded pid is checked for liveness rather
 * than trusted, or a killed daemon would lock the corpus out permanently.
 */
export async function acquireDaemonLock(
  now: Date,
  isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<LockOutcome> {
  const path = lockPath();
  const existing = await readLock(path);
  if (
    existing !== undefined &&
    existing.pid !== process.pid &&
    isAlive(existing.pid)
  ) {
    return { acquired: false, heldByPid: existing.pid };
  }
  await writeFile(
    path,
    `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return { acquired: true };
}

export async function releaseDaemonLock(): Promise<void> {
  try {
    const existing = await readLock(lockPath());
    if (existing?.pid !== process.pid) return;
    await unlink(lockPath());
  } catch {
    // A lock already gone is the state we wanted.
  }
}

async function readLock(
  path: string,
): Promise<z.infer<typeof lockFileSchema> | undefined> {
  try {
    const parsed = lockFileSchema.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Signal 0 tests for existence without delivering anything. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
