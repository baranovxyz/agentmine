import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, openDb } from "../src/db/client.js";
import { acquireWriteLock, lockPathFor } from "../src/db/lock.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(TEST_DIR);
const CLI_ENTRY = join(PACKAGE_DIR, "src", "cli.ts");
const CODEX_FIXTURE = join(TEST_DIR, "fixtures", "codex", "tiny.jsonl");
const tempDirs: string[] = [];

interface CorpusFixture {
  root: string;
  home: string;
  dataHome: string;
  dbPath: string;
  daemonLockPath: string;
  mirroredFile: string;
}

function corpusFixture(options: { withSource?: boolean } = {}): CorpusFixture {
  const root = mkdtempSync(join(tmpdir(), "agentmine-daemon-lifecycle-"));
  tempDirs.push(root);
  const home = join(root, "home");
  const dataHome = join(root, "data");
  const sourceDir = join(home, ".codex", "sessions");
  const sessionsDir = join(dataHome, "agentmine", "sessions");
  const sourceFile = join(sourceDir, "tiny.jsonl");
  const dbPath = join(sessionsDir, "sessions.db");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  if (options.withSource !== false) {
    copyFileSync(CODEX_FIXTURE, sourceFile);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(sourceFile, old, old);
  } else {
    writeFileSync(join(sourceDir, "ignored.txt"), "not a Codex transcript\n");
  }
  openDb({ path: dbPath }).close();
  return {
    root,
    home,
    dataHome,
    dbPath,
    daemonLockPath: join(sessionsDir, "daemon.lock"),
    mirroredFile: join(sessionsDir, "codex", "tiny.jsonl"),
  };
}

function startDaemon(
  fixture: CorpusFixture,
  options: { dbPath?: string } = {},
): {
  child: ChildProcessWithoutNullStreams;
  output: { stdout: string; stderr: string };
} {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      CLI_ENTRY,
      "daemon",
      "--only",
      "codex",
      "--settle-ms",
      "1",
      "--supersession-interval-ms",
      "50",
      "--no-extract",
    ],
    {
      env: {
        ...process.env,
        HOME: fixture.home,
        XDG_DATA_HOME: fixture.dataHome,
        AGENTMINE_DB: options.dbPath ?? fixture.dbPath,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });
  return { child, output };
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcessWithoutNullStreams,
  output: { stdout: string; stderr: string },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `daemon exited before the expected state: ${output.stderr}${output.stdout}`,
      );
    }
    await delay(20);
  }
  throw new Error(
    `daemon did not reach the expected state within ${timeoutMs}ms: ${output.stderr}${output.stdout}`,
  );
}

async function closeResult(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    ),
    delay(timeoutMs).then(() => {
      throw new Error(`daemon did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

function sessionCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function advanceCorpusSchema(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
      String(CURRENT_SCHEMA_VERSION + 1),
    );
  } finally {
    db.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("daemon child lifecycle", () => {
  it("releases the daemon lock after a controlled startup failure", async () => {
    const fixture = corpusFixture();
    const blockedParent = join(fixture.root, "blocked-db-parent");
    writeFileSync(blockedParent, "not a directory\n");
    const failed = startDaemon(fixture, {
      dbPath: join(blockedParent, "sessions.db"),
    });

    expect((await closeResult(failed.child)).code).not.toBe(0);
    expect(existsSync(fixture.daemonLockPath)).toBe(false);

    const restarted = startDaemon(fixture);
    try {
      await waitFor(
        () => restarted.output.stderr.includes('"phase":"daemon.started"'),
        restarted.child,
        restarted.output,
      );
      expect(restarted.child.kill("SIGTERM")).toBe(true);
      expect(await closeResult(restarted.child)).toMatchObject({ code: 0 });
      expect(existsSync(fixture.daemonLockPath)).toBe(false);
    } finally {
      restarted.child.kill("SIGKILL");
    }
  }, 10_000);

  it("treats an empty startup reconciliation as a successful no-op", async () => {
    const fixture = corpusFixture({ withSource: false });
    const { child, output } = startDaemon(fixture);
    try {
      await waitFor(
        () => output.stderr.includes('"phase":"daemon.imported"'),
        child,
        output,
      );
      await delay(5_200);

      expect(child.kill("SIGTERM")).toBe(true);
      expect(await closeResult(child)).toMatchObject({ code: 0 });
      expect(output.stderr).not.toContain('"phase":"daemon.error"');
      expect(
        output.stderr.match(/"phase":"daemon\.importing"/g) ?? [],
      ).toHaveLength(1);
      expect(sessionCount(fixture.dbPath)).toBe(0);
      expect(existsSync(fixture.daemonLockPath)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);

  it("imports an old unserviced file during unbounded startup reconciliation", async () => {
    const fixture = corpusFixture();
    const { child, output } = startDaemon(fixture);
    try {
      await waitFor(
        () => output.stderr.includes('"phase":"daemon.imported"'),
        child,
        output,
      );

      expect(child.kill("SIGTERM")).toBe(true);
      expect(await closeResult(child)).toMatchObject({ code: 0 });
      expect(sessionCount(fixture.dbPath)).toBe(1);
      expect(existsSync(fixture.daemonLockPath)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  }, 10_000);

  it("retries a bounded lock-contention failure without discarding the import", async () => {
    const fixture = corpusFixture();
    const held = await acquireWriteLock({
      command: "daemon bounded retry holder",
      dbPath: fixture.dbPath,
    });
    const { child, output } = startDaemon(fixture);
    try {
      await waitFor(
        () => output.stderr.includes('"phase":"daemon.error"'),
        child,
        output,
        8_000,
      );
      held.release();

      await waitFor(
        () => output.stderr.includes('"phase":"daemon.imported"'),
        child,
        output,
        8_000,
      );
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await closeResult(child)).toMatchObject({ code: 0 });
      expect(sessionCount(fixture.dbPath)).toBe(1);
      expect(existsSync(fixture.daemonLockPath)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      held.release();
    }
  }, 20_000);

  it("cancels a lock-waiting child on SIGTERM before releasing the daemon lease", async () => {
    const fixture = corpusFixture();
    const held = await acquireWriteLock({
      command: "daemon lifecycle test holder",
      dbPath: fixture.dbPath,
    });
    const { child, output } = startDaemon(fixture);
    try {
      await waitFor(
        () => output.stderr.includes('"phase":"db.lock.wait"'),
        child,
        output,
      );

      expect(child.kill("SIGTERM")).toBe(true);
      expect(await closeResult(child)).toMatchObject({ code: 0 });
      expect(output.stderr).not.toContain('"phase":"daemon.error"');
      expect(existsSync(fixture.daemonLockPath)).toBe(false);

      await held.release();
      await delay(500);
      expect(existsSync(lockPathFor(fixture.dbPath))).toBe(false);
      expect(sessionCount(fixture.dbPath)).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await held.release();
    }
  }, 10_000);

  it("drains the same lock-waiting child when corpus supersession stands it down", async () => {
    const fixture = corpusFixture();
    const held = await acquireWriteLock({
      command: "daemon lifecycle supersession holder",
      dbPath: fixture.dbPath,
    });
    const { child, output } = startDaemon(fixture);
    try {
      await waitFor(
        () => output.stderr.includes('"phase":"db.lock.wait"'),
        child,
        output,
      );
      advanceCorpusSchema(fixture.dbPath);

      const closed = await closeResult(child);
      expect(closed.code).not.toBe(0);
      expect(output.stderr).toContain('"phase":"daemon.stood-down"');
      expect(output.stderr).not.toContain('"phase":"daemon.error"');
      expect(existsSync(fixture.daemonLockPath)).toBe(false);

      await held.release();
      await delay(500);
      expect(existsSync(lockPathFor(fixture.dbPath))).toBe(false);
      expect(sessionCount(fixture.dbPath)).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await held.release();
    }
  }, 10_000);
});
