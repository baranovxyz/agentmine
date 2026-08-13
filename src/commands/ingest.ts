import { spawn } from "node:child_process";
import { defineCommand } from "citty";
import { z } from "zod";
import { CliError, Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { assertConfiguredCorpusReady } from "../db/client.js";
import { resolveSelfInvocation } from "../runtime.js";

const CHILD_DIAGNOSTIC_LIMIT = 500;

const childCliErrorSchema = z.object({
  code: z.number().int(),
  name: z.string(),
  message: z.string(),
  category: z.enum(["user", "system", "transient"]),
  retryable: z.boolean(),
  path: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
  details: z
    .array(
      z.object({
        path: z.string(),
        code: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

const childErrorEnvelopeSchema = z.object({
  version: z.number().int(),
  status: z.literal("error"),
  command: z.string(),
  data: z.null(),
  errors: z.array(childCliErrorSchema).min(1),
  traceId: z.string(),
});

interface ChildResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

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
        assertConfiguredCorpusReady();
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
    throw ingestStepFailure(step, result);
  }
  reportProgressImmediate("ingest.step.done", { step, duration_ms: duration });
  steps.push({ step, status: "success", duration_ms: duration });
}

function runSelf(args: string[]): Promise<ChildResult> {
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

/** Convert a failed child command into the error exposed by `agentmine ingest`. */
export function ingestStepFailure(step: string, result: ChildResult): CliError {
  try {
    const rawEnvelope: unknown = JSON.parse(result.stdout);
    const envelope = childErrorEnvelopeSchema.safeParse(rawEnvelope);
    if (envelope.success) {
      const firstError = envelope.data.errors[0];
      if (firstError !== undefined) return new CliError(firstError);
    }
  } catch {
    // Fall through to a bounded diagnostic when stdout is not JSON.
  }

  const exitCode =
    result.exitCode === null ? "signal" : String(result.exitCode);
  return Errors.internal(
    `ingest step ${step} failed (exit ${exitCode}); child did not emit a valid error envelope; ` +
      `stdout: ${diagnosticExcerpt(result.stdout)}; stderr: ${diagnosticExcerpt(result.stderr)}`,
  );
}

function diagnosticExcerpt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "<empty>";
  return trimmed.length > CHILD_DIAGNOSTIC_LIMIT
    ? `${trimmed.slice(0, CHILD_DIAGNOSTIC_LIMIT)}...`
    : trimmed;
}
