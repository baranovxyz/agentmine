import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { type DatabaseType, openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const CLI = ["tsx", join(REPO, "src", "cli.ts")];
const runOllamaE2E = process.env["AGENTMINE_RUN_OLLAMA_E2E"] === "1";

async function runCli(args: string[], env: Record<string, string> = {}) {
  return execa("npx", ["--no-install", ...CLI, ...args], {
    cwd: REPO,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function makeSession(
  overrides: Partial<CanonicalSession> = {},
): CanonicalSession {
  return {
    id: "cc--ollama-e2e",
    source: "claude-code",
    projectPath: "/tmp/agentmine-ollama-e2e",
    messages: [],
    contentHash: "ollama-e2e",
    ...overrides,
  };
}

const describeIfOllama = runOllamaE2E ? describe : describe.skip;

describeIfOllama("ollama embeddings e2e", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseType;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-ollama-e2e-"));
    dbPath = join(tempDir, "test.db");
    db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--ollama-auth",
        contentHash: "ollama-auth",
        title: "OAuth redirect fix",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "fix oauth callback login bounce",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "preserve return url and redirect after session creation",
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--ollama-sqlite",
        contentHash: "ollama-sqlite",
        title: "SQLite schema mismatch",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "debug sqlite bundled schema mismatch",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "compare schema.sql with schemaText.ts",
            toolCalls: [],
          },
        ],
      }),
    );
    db.close();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("indexes with real nomic-embed-text and retrieves a semantic match", async () => {
    const embed = await runCli(
      [
        "embed",
        "--provider",
        "ollama",
        "--model",
        "nomic-embed-text",
        "--limit",
        "10",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(embed.exitCode).toBe(0);
    const embedJson = JSON.parse(embed.stdout.trim());
    expect(embedJson.data.provider).toBe("ollama");
    expect(embedJson.data.model).toBe("nomic-embed-text");
    expect(embedJson.data.embedded_chunks).toBeGreaterThan(0);

    const similar = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "ollama",
        "--model",
        "nomic-embed-text",
        "--limit",
        "2",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(similar.exitCode).toBe(0);
    const similarJson = JSON.parse(similar.stdout.trim());
    expect(similarJson.data.mode).toBe("embedding");
    expect(similarJson.data.rows[0].session_id).toBe("cc--ollama-auth");
    expect(similarJson.data.rows[0].embedding_score).toBeGreaterThan(0);
  }, 30_000);
});
