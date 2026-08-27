import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHILD_STDERR_TAIL_MAX_CHARS, runSelf } from "../src/self-exec.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("self execution lifecycle", () => {
  it("terminates and awaits an active child when its owner aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const child = runSelf([], {
      signal: controller.signal,
      invocation: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        programPath: process.execPath,
        programIsExecutable: true,
      },
    });

    setTimeout(() => controller.abort(), 25);
    const result = await child;

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === "win32")(
    "terminates descendants in the stage process group before resolving",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-self-exec-tree-"));
      tempDirs.push(dir);
      const readyPath = join(dir, "grandchild-started");
      const survivedPath = join(dir, "grandchild-survived");
      const grandchildProgram =
        `const fs = require("node:fs"); ` +
        `setTimeout(() => fs.writeFileSync(${JSON.stringify(survivedPath)}, "survived"), 300); ` +
        `setInterval(() => {}, 1_000);`;
      const parentProgram =
        `const { spawn } = require("node:child_process"); ` +
        `const fs = require("node:fs"); ` +
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildProgram)}], { stdio: "ignore" }); ` +
        `fs.writeFileSync(${JSON.stringify(readyPath)}, "ready"); ` +
        `setInterval(() => {}, 1_000);`;
      const controller = new AbortController();
      const child = runSelf([], {
        signal: controller.signal,
        invocation: {
          command: process.execPath,
          args: ["-e", parentProgram],
          programPath: process.execPath,
          programIsExecutable: true,
        },
      });

      await waitForFile(readyPath);
      controller.abort();
      const result = await child;
      await delay(500);

      expect(result.aborted).toBe(true);
      expect(existsSync(survivedPath)).toBe(false);
    },
  );

  it("keeps only a bounded diagnostic tail from a noisy child", async () => {
    const result = await runSelf([], {
      invocation: {
        command: process.execPath,
        args: [
          "-e",
          'for (let i = 0; i < 512; i++) process.stderr.write("x".repeat(1024)); process.stderr.write("TAIL\\n")',
        ],
        programPath: process.execPath,
        programIsExecutable: true,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.length).toBe(CHILD_STDERR_TAIL_MAX_CHARS);
    expect(result.stderr.endsWith("TAIL\n")).toBe(true);
  });

  it("observes only complete structured progress lines", async () => {
    const events: Array<{ event: string; phase: string }> = [];
    const result = await runSelf([], {
      invocation: {
        command: process.execPath,
        args: [
          "-e",
          `process.stderr.write('plain warning\\n{"event":"pro'); setTimeout(() => { process.stderr.write('gress","phase":"db.lock.wait","waited_ms":0}\\nnot-json\\n'); }, 10)`,
        ],
        programPath: process.execPath,
        programIsExecutable: true,
      },
      onProgress: (event) => events.push(event),
    });

    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      { event: "progress", phase: "db.lock.wait", waited_ms: 0 },
    ]);
    expect(result.stderr).toContain("plain warning\n");
    expect(result.stderr).toContain("not-json\n");
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await delay(10);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
