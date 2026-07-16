import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError } from "../src/contract/errors.js";
import {
  acquireWriteLock,
  lockPathFor,
  withWriteLock,
} from "../src/db/lock.js";

describe("db write lock", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentmine-lock-test-"));
    dbPath = join(dir, "sessions.db");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("writes the lock file beside the DB with the holder's identity", async () => {
    const lock = await acquireWriteLock({
      command: "agentmine normalize",
      dbPath,
    });
    try {
      expect(lock.path).toBe(lockPathFor(dbPath));
      expect(existsSync(lock.path)).toBe(true);
      const meta = JSON.parse(readFileSync(lock.path, "utf8"));
      expect(meta.pid).toBe(process.pid);
      expect(meta.host).toBe(hostname());
      expect(meta.command).toBe("agentmine normalize");
    } finally {
      lock.release();
    }
  });

  it("releases so the next writer can acquire", async () => {
    const first = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
    });
    first.release();
    expect(existsSync(lockPathFor(dbPath))).toBe(false);

    // Second acquire must not block now that the first released.
    const second = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
      waitMs: 200,
    });
    second.release();
  });

  it("blocks a second writer while held, then fails with a retryable LOCKED error", async () => {
    const held = await acquireWriteLock({
      command: "agentmine ingest",
      dbPath,
    });
    try {
      const err = await acquireWriteLock({
        command: "agentmine normalize",
        dbPath,
        waitMs: 150,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(CliError);
      if (!(err instanceof CliError)) throw new Error("expected a CliError");
      expect(err.cliName).toBe("LOCKED");
      expect(err.retryable).toBe(true);
      expect(err.message).toMatch(/write is in progress/);
    } finally {
      held.release();
    }
  });

  it("reclaims a stale lock whose PID is dead on this host", async () => {
    // A PID that is essentially guaranteed not to exist.
    const deadPid = 2_147_483_646;
    writeFileSync(
      lockPathFor(dbPath),
      JSON.stringify({
        pid: deadPid,
        host: hostname(),
        command: "agentmine ingest",
        acquiredAt: Date.now(),
      }),
    );

    const lock = await acquireWriteLock({
      command: "agentmine normalize",
      dbPath,
      waitMs: 200,
    });
    try {
      const meta = JSON.parse(readFileSync(lock.path, "utf8"));
      expect(meta.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("reclaims a corrupt lock file", async () => {
    writeFileSync(lockPathFor(dbPath), "{ not json");
    const lock = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
      waitMs: 200,
    });
    lock.release();
    expect(existsSync(lockPathFor(dbPath))).toBe(false);
  });

  it("withWriteLock releases even when the body throws", async () => {
    await expect(
      withWriteLock({ command: "agentmine normalize", dbPath }, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(existsSync(lockPathFor(dbPath))).toBe(false);

    // Lock is free again.
    const value = await withWriteLock(
      { command: "agentmine normalize", dbPath },
      () => 42,
    );
    expect(value).toBe(42);
  });
});
