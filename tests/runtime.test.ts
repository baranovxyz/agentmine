import { describe, expect, it } from "vitest";
import { resolveSelfInvocation } from "../src/runtime.js";

describe("runtime self invocation", () => {
  it("re-executes a standalone binary directly", () => {
    expect(
      resolveSelfInvocation(["sync"], {
        standalone: true,
        execPath: "/tmp/agentmine",
        execArgv: ["--ignored"],
        argv: ["/tmp/agentmine"],
      }),
    ).toEqual({
      command: "/tmp/agentmine",
      args: ["sync"],
      // A standalone build is its own program, so the two are the same file.
      programPath: "/tmp/agentmine",
      programIsExecutable: true,
    });
  });

  it("re-executes the Node entrypoint with existing runtime arguments", () => {
    expect(
      resolveSelfInvocation(["extract"], {
        standalone: false,
        execPath: "/usr/bin/node",
        execArgv: ["--import", "tsx"],
        argv: ["/usr/bin/node", "/repo/src/cli.ts"],
      }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["--import", "tsx", "/repo/src/cli.ts", "extract"],
      // Under Node the command is the runtime, which a version manager may
      // move for reasons unrelated to Agentmine, so the entrypoint is what
      // identifies this installation.
      programPath: "/repo/src/cli.ts",
      programIsExecutable: false,
    });
  });

  it("fails when a Node entrypoint is unavailable", () => {
    expect(() =>
      resolveSelfInvocation(["schema"], {
        standalone: false,
        execPath: "/usr/bin/node",
        execArgv: [],
        argv: ["/usr/bin/node"],
      }),
    ).toThrow("Agentmine entrypoint is unavailable");
  });
});
