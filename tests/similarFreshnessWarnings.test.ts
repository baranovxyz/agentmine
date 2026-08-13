import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDb } from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const CLI = ["tsx", join(REPO, "src", "cli.ts")];

const envelopeSchema = z.object({
  status: z.literal("success"),
  warnings: z
    .array(z.object({ name: z.string(), message: z.string() }))
    .optional(),
  data: z.object({
    warnings: z.array(z.string()).optional(),
    excluded_sessions: z.array(z.string()),
  }),
});

describe("similar extraction freshness warnings", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-similar-freshness-"));
    dbPath = join(tempDir, "sessions.db");
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, {
      id: "cc--similar-freshness",
      source: "claude-code",
      projectPath: "/tmp/agentmine-similar-freshness",
      title: "Snapshot anchor",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "snapshot anchor",
          toolCalls: [],
        },
      ],
      contentHash: "similar-freshness-v1",
    });
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("warns only when nonempty exclusion expansion reads extracted facts", async () => {
    const baseArgs = [
      "similar",
      "snapshot banana recipe vacation itinerary",
      "--all-projects",
      "--mode",
      "fts",
    ];

    const withoutExclusion = envelopeSchema.parse(
      JSON.parse((await runCli(baseArgs, dbPath)).stdout.trim()),
    );
    expect(withoutExclusion.warnings).toBeUndefined();
    expect(withoutExclusion.data.warnings).toContain("low_confidence_matches");

    const withExclusion = envelopeSchema.parse(
      JSON.parse(
        (
          await runCli(
            [...baseArgs, "--exclude-session", "cc--unrelated"],
            dbPath,
          )
        ).stdout.trim(),
      ),
    );
    expect(withExclusion.warnings).toContainEqual(
      expect.objectContaining({ name: "EXTRACTION_PENDING" }),
    );
    expect(withExclusion.data.warnings).toContain("low_confidence_matches");
    expect(withExclusion.data.excluded_sessions).toContain("cc--unrelated");
  }, 15_000);
});

async function runCli(args: string[], path: string) {
  const result = await execa("npx", ["--no-install", ...CLI, ...args], {
    cwd: REPO,
    reject: false,
    env: {
      ...process.env,
      NO_COLOR: "1",
      AGENTMINE_DB: path,
      AGENTMINE_CURRENT_SESSION_ID: "",
      AGENTMINE_EXCLUDE_SESSION_IDS: "",
      AGENTMINE_CURRENT_RUN_FAMILY_SESSION_ID: "",
    },
  });
  expect(result.exitCode).toBe(0);
  return result;
}
