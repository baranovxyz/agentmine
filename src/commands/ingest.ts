import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { resolveSelfInvocation } from "../runtime.js";

export const ingestCommand = defineCommand({
  meta: {
    name: "ingest",
    description:
      "Run sync, normalize, and extract as one idempotent import workflow",
  },
  args: {
    source: {
      type: "string",
      description: "Optional source filter passed to sync and normalize",
    },
    "claude-history": {
      type: "string",
      description:
        "Comma-separated Claude Code history tarballs passed to sync",
    },
    "discover-claude-history": {
      type: "boolean",
      default: false,
      description: "Pass --discover-claude-history to sync",
    },
    "no-redact": {
      type: "boolean",
      default: false,
      description: "Pass --no-redact to normalize",
    },
    force: {
      type: "boolean",
      default: false,
      description: "Pass --force to normalize",
    },
    since: {
      type: "string",
      description:
        "Pass --since to normalize for incremental imports (e.g. '1d', '2w')",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine ingest",
      handler: async () => {
        const steps: Array<{
          step: string;
          status: "success";
          duration_ms: number;
        }> = [];

        const syncArgs = ["sync"];
        if (args.source) syncArgs.push("--source", String(args.source));
        if (args["claude-history"])
          syncArgs.push("--claude-history", String(args["claude-history"]));
        if (args["discover-claude-history"])
          syncArgs.push("--discover-claude-history");
        await runStep("sync", syncArgs, steps);

        const normalizeArgs = ["normalize"];
        if (args.source) normalizeArgs.push("--source", String(args.source));
        if (args.force) normalizeArgs.push("--force");
        if (args["no-redact"]) normalizeArgs.push("--no-redact");
        if (args.since) normalizeArgs.push("--since", String(args.since));
        await runStep("normalize", normalizeArgs, steps);

        await runStep("extract", ["extract"], steps);

        return { data: { steps } };
      },
    });
  },
});

async function runStep(
  step: string,
  args: string[],
  steps: Array<{ step: string; status: "success"; duration_ms: number }>,
): Promise<void> {
  reportProgressImmediate("ingest.step.start", { step, args });
  const started = Date.now();
  const result = await runSelf(args);
  const duration = Date.now() - started;
  if (result.exitCode !== 0) {
    throw Errors.internal(
      `ingest step ${step} failed (exit ${result.exitCode}): ${result.stdout.slice(0, 500)}${result.stderr.slice(0, 500)}`,
    );
  }
  reportProgressImmediate("ingest.step.done", { step, duration_ms: duration });
  steps.push({ step, status: "success", duration_ms: duration });
}

function runSelf(
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const invocation = resolveSelfInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
