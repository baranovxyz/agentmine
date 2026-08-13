import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ingestStepFailure } from "../src/commands/ingest.js";
import { acquireWriteLock } from "../src/db/lock.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");

const errorEnvelopeSchema = z.object({
  status: z.literal("error"),
  command: z.literal("agentmine ingest"),
  errors: z
    .array(
      z.object({
        code: z.number(),
        name: z.string(),
        message: z.string(),
        category: z.enum(["user", "system", "transient"]),
        retryable: z.boolean(),
        path: z.string().optional(),
        retryAfterSeconds: z.number().optional(),
      }),
    )
    .min(1),
});

describe("ingest child error propagation", () => {
  it("preserves a retryable LOCKED child error and transient exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-ingest-locked-"));
    const dbPath = join(dir, "sessions.db");
    const held = await acquireWriteLock({
      command: "agentmine normalize",
      dbPath,
    });

    try {
      const result = await execa(
        TSX_BIN,
        [CLI_ENTRY, "ingest", "--source", "cline", "--since", "1d"],
        {
          cwd: REPO,
          reject: false,
          env: {
            ...process.env,
            NO_COLOR: "1",
            HOME: join(dir, "home"),
            XDG_DATA_HOME: join(dir, "data"),
            CLINE_SESSION_DATA_DIR: join(dir, "missing-cline-sessions"),
            AGENTMINE_DB: dbPath,
            AGENTMINE_LOCK_TIMEOUT_MS: "0",
          },
        },
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(4);
      const rawEnvelope: unknown = JSON.parse(result.stdout.trim());
      const envelope = errorEnvelopeSchema.parse(rawEnvelope);
      expect(envelope.errors[0]).toMatchObject({
        code: 3003,
        name: "LOCKED",
        category: "transient",
        retryable: true,
        retryAfterSeconds: 5,
      });
    } finally {
      held.release();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves every supported field from the first child error", () => {
    const error = ingestStepFailure("sync", {
      exitCode: 2,
      stdout: JSON.stringify({
        version: 1,
        status: "error",
        command: "agentmine sync",
        data: null,
        errors: [
          {
            code: 1002,
            name: "INVALID_PATH",
            message: "The source path is unavailable",
            category: "user",
            retryable: false,
            path: "/tmp/source",
            retryAfterSeconds: 12,
          },
          {
            code: 2999,
            name: "INTERNAL",
            message: "Must not replace the first error",
            category: "system",
            retryable: false,
          },
        ],
        traceId: "child-trace",
      }),
      stderr: "",
    });

    expect(error.toJSON()).toEqual({
      code: 1002,
      name: "INVALID_PATH",
      message: "The source path is unavailable",
      category: "user",
      retryable: false,
      path: "/tmp/source",
      retryAfterSeconds: 12,
    });
  });

  it("falls back to a bounded INTERNAL error for malformed child output", () => {
    const error = ingestStepFailure("extract", {
      exitCode: 9,
      stdout: "x".repeat(800),
      stderr: "y".repeat(800),
    });

    expect(error.toJSON()).toMatchObject({
      code: 2999,
      name: "INTERNAL",
      category: "system",
      retryable: false,
    });
    expect(error.message).toContain(
      "child did not emit a valid error envelope",
    );
    expect(error.message).toContain("x".repeat(500));
    expect(error.message).not.toContain("x".repeat(501));
    expect(error.message).toContain("y".repeat(500));
    expect(error.message).not.toContain("y".repeat(501));
  });

  it("falls back to INTERNAL for JSON that is not an error envelope", () => {
    const error = ingestStepFailure("normalize", {
      exitCode: 3,
      stdout: JSON.stringify({ status: "error", errors: [] }),
      stderr: "child diagnostic",
    });

    expect(error.toJSON()).toMatchObject({
      code: 2999,
      name: "INTERNAL",
      category: "system",
      retryable: false,
    });
    expect(error.message).toContain('{"status":"error","errors":[]}');
    expect(error.message).toContain("child diagnostic");
  });
});
