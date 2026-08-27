import {
  chmodSync,
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
      await lock.release();
    }
  });

  it("releases so the next writer can acquire", async () => {
    const first = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
    });
    await first.release();
    expect(existsSync(lockPathFor(dbPath))).toBe(false);

    // Second acquire must not block now that the first released.
    const second = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
      waitMs: 200,
    });
    await second.release();
  });

  it.skipIf(process.platform === "win32")(
    "reports a release failure and retains ownership for a safe retry",
    async () => {
      const lock = await acquireWriteLock({
        command: "agentmine extract",
        dbPath,
      });
      chmodSync(dir, 0o500);
      try {
        expect(() => lock.release()).toThrow(/Failed to release/);
        expect(existsSync(lock.path)).toBe(true);
      } finally {
        chmodSync(dir, 0o700);
      }

      lock.release();
      expect(existsSync(lock.path)).toBe(false);
    },
  );

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
      await held.release();
    }
  });

  it("fails closed on a stale lock whose PID is dead on this host", async () => {
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

    const error = await acquireWriteLock({
      command: "agentmine normalize",
      dbPath,
      waitMs: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("expected a CliError");
    expect(error.cliName).toBe("LOCKED");
    expect(error.message).toContain(lockPathFor(dbPath));
    expect(JSON.parse(readFileSync(lockPathFor(dbPath), "utf8"))).toMatchObject(
      {
        pid: deadPid,
      },
    );
  });

  it("fails closed on a corrupt lock file", async () => {
    writeFileSync(lockPathFor(dbPath), "{ not json");
    const error = await acquireWriteLock({
      command: "agentmine extract",
      dbPath,
      waitMs: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CliError);
    if (!(error instanceof CliError)) throw new Error("expected a CliError");
    expect(error.cliName).toBe("LOCKED");
    expect(readFileSync(lockPathFor(dbPath), "utf8")).toBe("{ not json");
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
