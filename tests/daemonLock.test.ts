import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDaemonLock,
  releaseDaemonLock,
} from "../src/daemon/liveness.js";

const tempDirs: string[] = [];

afterEach(() => {
  releaseDaemonLock();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function lockFixture(): { dir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-daemon-lock-"));
  tempDirs.push(dir);
  return { dir, lockPath: join(dir, "daemon.lock") };
}

describe("daemon singleton lock", () => {
  it("atomically admits exactly one concurrent daemon", async () => {
    const { dir, lockPath } = lockFixture();
    const startPath = join(dir, "start");
    const firstReady = join(dir, "first-ready");
    const secondReady = join(dir, "second-ready");
    const first = startRacer(lockPath, startPath, firstReady);
    const second = startRacer(lockPath, startPath, secondReady);
    await Promise.all([waitForFile(firstReady), waitForFile(secondReady)]);

    writeFileSync(startPath, "start");
    const outcomes = await Promise.all([first, second]);

    expect(outcomes.sort()).toEqual(["acquired", "refused"]);
    expect(readFileSync(lockPath, "utf8")).not.toBe("");
  });

  it("fails closed on malformed ownership", async () => {
    const { lockPath } = lockFixture();
    writeFileSync(lockPath, "{not-json");

    const outcome = await acquireDaemonLock(new Date(), lockPath);

    expect(outcome).toMatchObject({
      acquired: false,
      ownershipKnown: false,
      path: lockPath,
    });
    expect(readFileSync(lockPath, "utf8")).toBe("{not-json");
  });

  it("fails closed on a well-formed stale-looking owner", async () => {
    const { lockPath } = lockFixture();
    const payload = `${JSON.stringify({
      pid: 2_147_483_646,
      startedAt: "2020-01-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(lockPath, payload);

    const outcome = await acquireDaemonLock(new Date(), lockPath);

    expect(outcome).toMatchObject({
      acquired: false,
      heldByPid: 2_147_483_646,
      ownershipKnown: true,
      path: lockPath,
    });
    expect(readFileSync(lockPath, "utf8")).toBe(payload);
  });

  it("removes only the lock generation it acquired", async () => {
    const { lockPath } = lockFixture();
    const outcome = await acquireDaemonLock(new Date(), lockPath);
    expect(outcome.acquired).toBe(true);

    releaseDaemonLock();

    expect(existsSync(lockPath)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reports an unlink failure and retains ownership for a safe retry",
    async () => {
      const { dir, lockPath } = lockFixture();
      const outcome = await acquireDaemonLock(new Date(), lockPath);
      expect(outcome.acquired).toBe(true);
      chmodSync(dir, 0o500);
      try {
        expect(() => releaseDaemonLock()).toThrow();
        expect(existsSync(lockPath)).toBe(true);
      } finally {
        chmodSync(dir, 0o700);
      }

      releaseDaemonLock();
      expect(existsSync(lockPath)).toBe(false);
    },
  );
});

function startRacer(
  lockPath: string,
  startPath: string,
  readyPath: string,
): Promise<string> {
  const moduleUrl = pathToFileURL(
    join(import.meta.dirname, "..", "src", "daemon", "liveness.ts"),
  ).href;
  const program = `
    import { existsSync, writeFileSync } from "node:fs";
    import { acquireDaemonLock } from ${JSON.stringify(moduleUrl)};
    writeFileSync(${JSON.stringify(readyPath)}, "ready");
    while (!existsSync(${JSON.stringify(startPath)})) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const outcome = await acquireDaemonLock(new Date(), ${JSON.stringify(lockPath)});
    process.stdout.write(outcome.acquired ? "acquired" : "refused");
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(`daemon lock racer exited ${String(code)}: ${stderr}`),
        );
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}
