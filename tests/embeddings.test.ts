import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import type { SimilarRow } from "../src/commands/similar.js";
import { mergeHybridRows } from "../src/commands/similar.js";
import { type DatabaseType, openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";
import {
  buildEmbeddingChunks,
  deserializeVector,
  estimateTokens,
  serializeVector,
  splitToBudget,
} from "../src/embeddings/chunks.js";
import { createEmbeddingProvider } from "../src/embeddings/providers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const CLI = ["tsx", join(REPO, "src", "cli.ts")];
const CLI_TEST_TIMEOUT = 15_000;
const CLI_HOOK_TIMEOUT = 20_000;

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
    id: `cc--${randomUUID()}`,
    source: "claude-code",
    projectPath: "/tmp/agentmine-embeddings",
    messages: [
      { turn: 1, role: "user", text: "fix auth redirect loop", toolCalls: [] },
      {
        turn: 2,
        role: "assistant",
        text: "use a loader redirect",
        toolCalls: [],
      },
    ],
    contentHash: randomUUID(),
    ...overrides,
  };
}

describe("embedding schema", () => {
  let dbPath: string;
  let tempDir: string;
  let db: DatabaseType;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-embeddings-"));
    dbPath = join(tempDir, "test.db");
    db = openDb({ path: dbPath });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates embedding tables on database initialization", () => {
    const names = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('embedding_models', 'embedding_chunks', 'embeddings', 'embedding_runs')
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(names.map((row) => row.name)).toEqual([
      "embedding_chunks",
      "embedding_models",
      "embedding_runs",
      "embeddings",
    ]);
  });

  it("deletes stale embedding chunks and vectors when a session is re-upserted", () => {
    const session = makeSession({
      id: "cc--embedding-lifecycle",
      contentHash: "v1",
    });
    upsertSession(db, session);

    db.prepare(
      `INSERT INTO embedding_models (provider, model, dimensions, created_at)
       VALUES ('fake', 'fake', 8, 1700000000)`,
    ).run();
    const modelId = (
      db.prepare(`SELECT id FROM embedding_models`).get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO embedding_chunks (
        session_id, start_turn, end_turn, chunk_index, source_kind, role_mix,
        chunker_version, redaction_version, content_hash, token_estimate,
        char_count, text_preview, retrieval_text, created_at
      ) VALUES (
        'cc--embedding-lifecycle', 1, 2, 0, 'session', 'assistant,user',
        'message-window-v1', 'embed-redact-v1', 'chunk-v1', 8,
        32, 'old preview', 'old retrieval text', 1700000000
      )`,
    ).run();
    const chunkId = (
      db.prepare(`SELECT id FROM embedding_chunks`).get() as { id: number }
    ).id;
    db.prepare(
      `INSERT INTO embeddings (chunk_id, model_id, vector, vector_norm, token_count, embedded_at)
       VALUES (?, ?, ?, 1, 8, 1700000001)`,
    ).run(chunkId, modelId, Buffer.alloc(32));

    upsertSession(
      db,
      makeSession({
        id: "cc--embedding-lifecycle",
        contentHash: "v2",
        messages: [{ turn: 1, role: "user", text: "new task", toolCalls: [] }],
      }),
    );

    const chunks = db
      .prepare(`SELECT COUNT(*) AS n FROM embedding_chunks`)
      .get() as { n: number };
    const vectors = db
      .prepare(`SELECT COUNT(*) AS n FROM embeddings`)
      .get() as { n: number };
    expect(chunks.n).toBe(0);
    expect(vectors.n).toBe(0);
  });
});

describe("embedding chunking and providers", () => {
  it("builds deterministic message-window chunks with stable hashes", () => {
    const session = makeSession({
      id: "cc--chunk-stable",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "fix sqlite migration mismatch",
          toolCalls: [],
        },
        {
          turn: 2,
          role: "assistant",
          text: "inspect schemaText and schema.sql",
          toolCalls: [],
        },
        {
          turn: 3,
          role: "assistant",
          text: "",
          toolCalls: [
            {
              name: "Shell",
              argsHash: "a",
              argsPreview: "",
              args: { command: "pnpm test" },
              exitCode: 1,
              outputPreview: "very long logs should not be embedded",
            },
          ],
        },
      ],
    });

    const first = buildEmbeddingChunks(session, {
      targetTokens: 20,
      maxTokens: 40,
    });
    const second = buildEmbeddingChunks(session, {
      targetTokens: 20,
      maxTokens: 40,
    });

    expect(first.skippedSecretChunks).toBe(0);
    expect(first.chunks.length).toBeGreaterThan(0);
    expect(first.chunks.map((chunk) => chunk.contentHash)).toEqual(
      second.chunks.map((chunk) => chunk.contentHash),
    );
    const allText = first.chunks.map((chunk) => chunk.retrievalText).join("\n");
    expect(allText).toContain("fix sqlite migration mismatch");
    expect(allText).toContain("tool: Shell");
    expect(allText).not.toContain("very long logs");
    expect(first.chunks[0]?.textPreview.length).toBeLessThanOrEqual(240);
  });

  it("splits a single oversized message into context-sized chunks", () => {
    const maxTokens = 40;
    // One giant pasted blob ~50x over the per-chunk budget, as a single message.
    const hugeLine = "alpha beta gamma delta ".repeat(400).trim();
    const session = makeSession({
      id: "cc--chunk-oversized",
      messages: [{ turn: 1, role: "user", text: hugeLine, toolCalls: [] }],
    });

    const result = buildEmbeddingChunks(session, {
      targetTokens: 20,
      maxTokens,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(estimateTokens(chunk.retrievalText)).toBeLessThanOrEqual(
        maxTokens,
      );
    }
  });

  it("splitToBudget leaves within-budget text untouched and bounds oversized text", () => {
    expect(splitToBudget("short text", 40)).toEqual(["short text"]);
    const long = "x".repeat(1000);
    const parts = splitToBudget(long, 40);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(long);
    for (const part of parts)
      expect(estimateTokens(part)).toBeLessThanOrEqual(40);
  });

  it("skips chunks with high-confidence secrets before storing retrieval text", () => {
    const session = makeSession({
      id: "cc--chunk-secret",
      messages: [
        {
          turn: 1,
          role: "user",
          text: "token sk-123456789012345678901234567890 should not embed",
          toolCalls: [],
        },
      ],
    });

    const result = buildEmbeddingChunks(session);

    expect(result.chunks).toHaveLength(0);
    expect(result.skippedSecretChunks).toBe(1);
    expect(result.skippedChunks[0]?.reason).toBe("high_confidence_secret");
  });

  it("serializes Float32 vectors round-trip", () => {
    const vector = new Float32Array([0.25, -0.5, 1]);
    const restored = deserializeVector(serializeVector(vector));
    expect([...restored]).toEqual([...vector]);
  });

  it("fake provider returns deterministic normalized vectors", async () => {
    const provider = createEmbeddingProvider("fake", "fake");
    const a = await provider.embedQuery("sqlite migration mismatch");
    const b = await provider.embedQuery("sqlite migration mismatch");
    const c = await provider.embedQuery("react auth redirect");

    expect(a.vector).toHaveLength(provider.modelInfo("fake").dimensions);
    expect([...a.vector]).toEqual([...b.vector]);
    expect([...a.vector]).not.toEqual([...c.vector]);
  });
});

describe("embed command", () => {
  let dbPath: string;
  let tempDir: string;
  let db: DatabaseType;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-embed-cli-"));
    dbPath = join(tempDir, "test.db");
    db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--embed-cli",
        contentHash: "embed-cli-v1",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "fix sqlite migration mismatch",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "compare schema sql with bundled schema text",
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

  it("advertises embed in schema discovery", async () => {
    const { exitCode, stdout } = await runCli(["schema"], {
      AGENTMINE_DB: dbPath,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.commands.embed).toBeTruthy();
    expect(parsed.data.commands.embed.annotations.readOnlyHint).toBe(false);
  });

  it("dry-run plans chunks without writing embeddings or run receipts", async () => {
    const { exitCode, stdout } = await runCli(
      ["embed", "--provider", "fake", "--model", "fake", "--dry-run"],
      { AGENTMINE_DB: dbPath },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.command).toBe("agentmine embed");
    expect(parsed.data.dry_run).toBe(true);
    expect(parsed.data.planned_chunks).toBeGreaterThan(0);
    expect(parsed.data.would_call_provider).toBe(false);

    const check = openDb({ path: dbPath });
    const chunks = check
      .prepare(`SELECT COUNT(*) AS n FROM embedding_chunks`)
      .get() as { n: number };
    const vectors = check
      .prepare(`SELECT COUNT(*) AS n FROM embeddings`)
      .get() as { n: number };
    const runs = check
      .prepare(`SELECT COUNT(*) AS n FROM embedding_runs`)
      .get() as { n: number };
    check.close();
    expect(chunks.n).toBe(0);
    expect(vectors.n).toBe(0);
    expect(runs.n).toBe(0);
  });

  it("indexes chunks with fake provider and skips cached chunks on rerun", async () => {
    const first = await runCli(
      ["embed", "--provider", "fake", "--model", "fake", "--limit", "10"],
      { AGENTMINE_DB: dbPath },
    );
    expect(first.exitCode).toBe(0);
    const firstParsed = JSON.parse(first.stdout.trim());
    expect(firstParsed.data.embedded_chunks).toBeGreaterThan(0);
    expect(firstParsed.data.status).toBe("completed");

    const second = await runCli(
      ["embed", "--provider", "fake", "--model", "fake", "--limit", "10"],
      { AGENTMINE_DB: dbPath },
    );
    expect(second.exitCode).toBe(0);
    const secondParsed = JSON.parse(second.stdout.trim());
    expect(secondParsed.data.embedded_chunks).toBe(0);
    expect(secondParsed.data.skipped_cached_chunks).toBeGreaterThan(0);
  });

  it(
    "dry-run reports already embedded chunks as cached without writing receipts",
    async () => {
      const first = await runCli(
        ["embed", "--provider", "fake", "--model", "fake", "--limit", "10"],
        { AGENTMINE_DB: dbPath },
      );
      expect(first.exitCode).toBe(0);

      const dryRun = await runCli(
        ["embed", "--provider", "fake", "--model", "fake", "--dry-run"],
        { AGENTMINE_DB: dbPath },
      );
      expect(dryRun.exitCode).toBe(0);
      const parsed = JSON.parse(dryRun.stdout.trim());
      expect(parsed.data.dry_run).toBe(true);
      expect(parsed.data.planned_chunks).toBeGreaterThan(0);
      expect(parsed.data.pending_chunks).toBe(0);
      expect(parsed.data.skipped_cached_chunks).toBe(
        parsed.data.planned_chunks,
      );
      expect(parsed.data.embedded_chunks).toBe(0);

      const check = openDb({ path: dbPath });
      const runs = check
        .prepare(`SELECT COUNT(*) AS n FROM embedding_runs`)
        .get() as { n: number };
      check.close();
      expect(runs.n).toBe(1);
    },
    CLI_TEST_TIMEOUT,
  );
});

describe("similar embedding modes", () => {
  let dbPath: string;
  let tempDir: string;
  let db: DatabaseType;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-similar-embedding-"));
    dbPath = join(tempDir, "test.db");
    db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--semantic-auth",
        contentHash: "semantic-auth",
        title: "Auth redirect",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "fix login bounce after oauth callback",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "preserve return url and redirect after session",
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--tool-only-auth",
        contentHash: "tool-only-auth",
        title: "Tool only auth",
        messages: [
          {
            turn: 1,
            role: "assistant",
            text: "",
            toolCalls: [
              {
                name: "Shell",
                argsHash: "tool-auth",
                argsPreview: "",
                args: { command: "oauth login redirect callback" },
                exitCode: 0,
              },
            ],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "custom--semantic-auth",
        source: "custom-cli",
        projectPath: "/tmp/other-project",
        contentHash: "semantic-auth-custom-cli",
        title: "Custom CLI Auth redirect",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "fix login bounce after oauth callback",
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--multi-auth",
        contentHash: "multi-auth",
        title: "Multi chunk auth",
        messages: Array.from({ length: 30 }, (_, idx) => ({
          turn: idx + 1,
          role: idx % 2 === 0 ? ("user" as const) : ("assistant" as const),
          text: `oauth login redirect callback preserve session return url repeated context ${idx} `.repeat(
            8,
          ),
          toolCalls: [],
        })),
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--sqlite-migration",
        contentHash: "semantic-sqlite",
        title: "SQLite migration",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "debug bundled schema migration mismatch",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "assistant",
            text: "compare schema sql and schema text",
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--long-fts-snippet",
        contentHash: "long-fts-snippet",
        title: "Long exact token snippet",
        messages: [
          {
            turn: 1,
            role: "user",
            text: `${"prefix context without the unique token ".repeat(20)} schemaTextUniqueNeedle`,
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--injected-auth",
        contentHash: "injected-auth",
        title: "Runtime instructions",
        messages: [
          {
            turn: 1,
            role: "user",
            text: `# AGENTS.md instructions\n\n${"oauth login redirect ".repeat(400)}`,
            toolCalls: [],
          },
        ],
      }),
    );
    upsertSession(
      db,
      makeSession({
        id: "cc--mixed-injected-auth",
        contentHash: "mixed-injected-auth",
        title: "Mixed authored and runtime context",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "Investigate the oauth login redirect behavior.",
            toolCalls: [],
          },
          {
            turn: 2,
            role: "user",
            text: "# AGENTS.md instructions\n\noauth login redirect runtime payload",
            toolCalls: [],
          },
          {
            turn: 3,
            role: "assistant",
            text: "Preserve the callback return URL.",
            toolCalls: [],
          },
        ],
      }),
    );
    db.close();
    const embed = await runCli(
      ["embed", "--provider", "fake", "--model", "fake", "--limit", "20"],
      { AGENTMINE_DB: dbPath },
    );
    expect(embed.exitCode).toBe(0);
  }, CLI_HOOK_TIMEOUT);

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("auto mode falls back to fts without current-session exclusion", async () => {
    const { exitCode, stdout } = await runCli(["similar", "schema migration"], {
      AGENTMINE_DB: dbPath,
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.mode).toBe("fts");
    expect(parsed.data.requested_mode).toBe("auto");
    expect(parsed.data.mode_selection.selected).toBe("fts");
    expect(parsed.data.mode_selection.fallback_reason).toBe(
      "missing_current_session_exclusion",
    );
    expect(parsed.data.mode_selection.fallback_reasons).toContain(
      "missing_current_session_exclusion",
    );
    expect(parsed.data.mode_selection.fallback_reasons).toContain(
      "missing_project_scope",
    );
    expect(parsed.data.mode_selection.guardrails.current_session_excluded).toBe(
      false,
    );
    expect(parsed.data.mode_selection.guardrails.project_scoped).toBe(false);
    expect(parsed.data.rows[0].session_id).toBe("cc--sqlite-migration");
  });

  it(
    "auto mode selects hybrid when semantic guardrails are satisfied",
    async () => {
      const { exitCode, stdout } = await runCli(
        [
          "similar",
          "oauth login redirect",
          "--project",
          "/tmp/agentmine-embeddings",
          "--provider",
          "fake",
          "--model",
          "fake",
          "--limit",
          "10",
        ],
        {
          AGENTMINE_DB: dbPath,
          AGENTMINE_CURRENT_SESSION_ID: "cc--semantic-auth",
        },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const ids = parsed.data.rows.map(
        (row: { session_id: string }) => row.session_id,
      );
      expect(parsed.data.mode).toBe("hybrid");
      expect(parsed.data.requested_mode).toBe("auto");
      expect(parsed.data.mode_selection).toEqual({
        requested: "auto",
        selected: "hybrid",
        guardrails: {
          current_session_excluded: true,
          project_scoped: true,
          embedding_index_found: true,
          provider_available: true,
        },
      });
      expect(parsed.data.warnings ?? []).not.toContain(
        "missing_current_session_exclusion",
      );
      expect(parsed.data.excluded_sessions).toContain("cc--semantic-auth");
      expect(ids).not.toContain("cc--semantic-auth");
    },
    CLI_HOOK_TIMEOUT,
  );

  it(
    "auto mode falls back to fts when the embedding model has no usable vectors",
    async () => {
      const writeDb = openDb({ path: dbPath });
      writeDb.prepare(`DELETE FROM embeddings`).run();
      writeDb.close();

      const { exitCode, stdout } = await runCli(
        [
          "similar",
          "oauth login redirect",
          "--project",
          "/tmp/agentmine-embeddings",
          "--provider",
          "fake",
          "--model",
          "fake",
          "--limit",
          "10",
        ],
        {
          AGENTMINE_DB: dbPath,
          AGENTMINE_CURRENT_SESSION_ID: "cc--semantic-auth",
        },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.mode).toBe("fts");
      expect(parsed.data.mode_selection.guardrails.embedding_index_found).toBe(
        false,
      );
      expect(parsed.data.mode_selection.fallback_reason).toBe(
        "missing_embedding_index",
      );
    },
    CLI_HOOK_TIMEOUT,
  );

  it("returns semantic matches in embedding mode", async () => {
    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "fake",
        "--model",
        "fake",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.mode).toBe("embedding");
    expect(parsed.data.rows[0].session_id).toContain("auth");
    expect(parsed.data.rows[0].session_id).not.toBe("cc--tool-only-auth");
    expect(parsed.data.rows[0].embedding_score).toBeGreaterThan(0);
    expect(parsed.data.rows[0].chunk_id).toBeTruthy();
  });

  it("excludes embedding chunks containing any injected source turn", async () => {
    const readDb = openDb({ path: dbPath, readonly: true });
    const mixedChunk = readDb
      .prepare(
        `SELECT start_turn, end_turn
           FROM embedding_chunks
          WHERE session_id = ?`,
      )
      .get("cc--mixed-injected-auth") as
      | { start_turn: number; end_turn: number }
      | undefined;
    readDb.close();
    expect(mixedChunk).toEqual({ start_turn: 1, end_turn: 3 });

    const baseArgs = [
      "similar",
      "oauth login redirect",
      "--mode",
      "embedding",
      "--provider",
      "fake",
      "--model",
      "fake",
      "--limit",
      "20",
    ];
    const filtered = await runCli(baseArgs, { AGENTMINE_DB: dbPath });
    expect(filtered.exitCode).toBe(0);
    const filteredJson = JSON.parse(filtered.stdout.trim());
    expect(
      filteredJson.data.rows.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).not.toContain("cc--injected-auth");
    expect(
      filteredJson.data.rows.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).not.toContain("cc--mixed-injected-auth");

    const included = await runCli([...baseArgs, "--include-injected"], {
      AGENTMINE_DB: dbPath,
    });
    expect(included.exitCode).toBe(0);
    const includedJson = JSON.parse(included.stdout.trim());
    expect(
      includedJson.data.rows.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).toContain("cc--injected-auth");
    expect(
      includedJson.data.rows.map(
        (row: { session_id: string }) => row.session_id,
      ),
    ).toContain("cc--mixed-injected-auth");
  });

  it("does not treat a mixed injected chunk as a usable auto-mode index", async () => {
    const writeDb = openDb({ path: dbPath });
    writeDb
      .prepare(
        `DELETE FROM embeddings
          WHERE chunk_id NOT IN (
            SELECT id FROM embedding_chunks WHERE session_id = ?
          )`,
      )
      .run("cc--mixed-injected-auth");
    writeDb.close();

    const args = [
      "similar",
      "oauth login redirect",
      "--project",
      "/tmp/agentmine-embeddings",
      "--provider",
      "fake",
      "--model",
      "fake",
      "--limit",
      "10",
    ];
    const filtered = await runCli(args, {
      AGENTMINE_DB: dbPath,
      AGENTMINE_CURRENT_SESSION_ID: "cc--semantic-auth",
    });
    expect(filtered.exitCode).toBe(0);
    const filteredJson = JSON.parse(filtered.stdout.trim());
    expect(filteredJson.data.mode_selection.selected).toBe("fts");
    expect(
      filteredJson.data.mode_selection.guardrails.embedding_index_found,
    ).toBe(false);

    const included = await runCli([...args, "--include-injected"], {
      AGENTMINE_DB: dbPath,
      AGENTMINE_CURRENT_SESSION_ID: "cc--semantic-auth",
    });
    expect(included.exitCode).toBe(0);
    const includedJson = JSON.parse(included.stdout.trim());
    expect(includedJson.data.mode_selection.selected).toBe("hybrid");
    expect(
      includedJson.data.mode_selection.guardrails.embedding_index_found,
    ).toBe(true);
  });

  it(
    "warns when semantic retrieval has no current-session exclusion context",
    async () => {
      const { exitCode, stdout } = await runCli(
        [
          "similar",
          "oauth login redirect",
          "--mode",
          "hybrid",
          "--provider",
          "fake",
          "--model",
          "fake",
        ],
        { AGENTMINE_DB: dbPath },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.excluded_sessions).toEqual([]);
      expect(parsed.data.exclusion_warning).toBe("missing_current_session");
      expect(parsed.data.warnings).toContain(
        "missing_current_session_exclusion",
      );
    },
    CLI_HOOK_TIMEOUT,
  );

  it("applies source and project filters to embedding candidates", async () => {
    const bySource = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "fake",
        "--model",
        "fake",
        "--source",
        "claude-code",
        "--limit",
        "10",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(bySource.exitCode).toBe(0);
    const sourceJson = JSON.parse(bySource.stdout.trim());
    expect(
      sourceJson.data.rows.every(
        (row: { source: string }) => row.source === "claude-code",
      ),
    ).toBe(true);

    const byProject = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "fake",
        "--model",
        "fake",
        "--project",
        "/tmp/agentmine-embeddings",
        "--limit",
        "10",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(byProject.exitCode).toBe(0);
    const projectJson = JSON.parse(byProject.stdout.trim());
    expect(
      projectJson.data.rows.every((row: { project_path: string }) =>
        row.project_path.startsWith("/tmp/agentmine-embeddings"),
      ),
    ).toBe(true);
  });

  it("applies time and root-session filters to embedding candidates", async () => {
    const currentDay = Math.floor(Date.parse("2026-07-23T10:00:00Z") / 1000);
    const priorDay = Math.floor(Date.parse("2026-07-22T10:00:00Z") / 1000);
    const writeDb = openDb({ path: dbPath });
    writeDb.prepare(`UPDATE sessions SET started_at = ?`).run(currentDay);
    writeDb
      .prepare(`UPDATE sessions SET started_at = ? WHERE id = ?`)
      .run(priorDay, "custom--semantic-auth");
    writeDb
      .prepare(`UPDATE sessions SET parent_session_id = ? WHERE id = ?`)
      .run("cc--semantic-auth", "cc--tool-only-auth");
    writeDb.close();

    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "fake",
        "--model",
        "fake",
        "--all-projects",
        "--root-only",
        "--since",
        "2026-07-23T00:00:00Z",
        "--until",
        "2026-07-24T00:00:00Z",
        "--limit",
        "20",
      ],
      { AGENTMINE_DB: dbPath },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const ids = parsed.data.rows.map(
      (row: { session_id: string }) => row.session_id,
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("custom--semantic-auth");
    expect(ids).not.toContain("cc--tool-only-auth");
    expect(parsed.data.root_only).toBe(true);
    expect(parsed.data.since_filter.epoch).toBe(
      Math.floor(Date.parse("2026-07-23T00:00:00Z") / 1000),
    );
    expect(parsed.data.until_filter.epoch).toBe(
      Math.floor(Date.parse("2026-07-24T00:00:00Z") / 1000),
    );
  });

  it("excludes the current session from hybrid candidates", async () => {
    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "hybrid",
        "--provider",
        "fake",
        "--model",
        "fake",
        "--limit",
        "10",
      ],
      {
        AGENTMINE_DB: dbPath,
        AGENTMINE_CURRENT_SESSION_ID: "cc--semantic-auth",
      },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const ids = parsed.data.rows.map(
      (row: { session_id: string }) => row.session_id,
    );
    expect(parsed.data.excluded_sessions).toContain("cc--semantic-auth");
    expect(ids).not.toContain("cc--semantic-auth");
  });

  it("groups embedding results by session and downranks tool-only chunks for normal queries", async () => {
    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "oauth login redirect",
        "--mode",
        "embedding",
        "--provider",
        "fake",
        "--model",
        "fake",
        "--limit",
        "10",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    const ids = parsed.data.rows.map(
      (row: { session_id: string }) => row.session_id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(parsed.data.rows[0].session_id).not.toBe("cc--tool-only-auth");
  });

  it("returns hybrid scores with snippets and reconstruction commands", async () => {
    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "sqlite schema mismatch",
        "--mode",
        "hybrid",
        "--provider",
        "fake",
        "--model",
        "fake",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.mode).toBe("hybrid");
    expect(parsed.data.rows[0].session_id).toBe("cc--sqlite-migration");
    expect(parsed.data.rows[0].fts_score).toBeDefined();
    expect(parsed.data.rows[0].embedding_score).toBeDefined();
    expect(parsed.data.rows[0].snippet).toContain("schema");
    expect(parsed.data.rows[0].reconstruct_command).toBe(
      "agentmine session cc--sqlite-migration --md",
    );
  });

  it("keeps the lexical snippet when hybrid also has an embedding match", async () => {
    const { exitCode, stdout } = await runCli(
      [
        "similar",
        "schemaTextUniqueNeedle",
        "--mode",
        "hybrid",
        "--provider",
        "fake",
        "--model",
        "fake",
      ],
      { AGENTMINE_DB: dbPath },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.data.rows[0].session_id).toBe("cc--long-fts-snippet");
    expect(parsed.data.rows[0].fts_score).toBeDefined();
    expect(parsed.data.rows[0].embedding_score).toBeDefined();
    expect(parsed.data.rows[0].snippet).toContain("schemaTextUniqueNeedle");
  });

  it("lets strong semantic-only sessions enter the hybrid top results", () => {
    const ftsRows = Array.from({ length: 5 }, (_, idx) =>
      similarRow(`cc--lexical-${idx}`),
    );
    const embeddingRows = [
      similarRow("cc--semantic-prior", {
        score: 0.96,
        embedding_score: 0.96,
        snippets: [
          { turn: 1, role: "chunk", snippet: "semantic prior context" },
        ],
        snippet: "semantic prior context",
      }),
    ];

    const rows = mergeHybridRows(ftsRows, embeddingRows);

    expect(rows.slice(0, 5).map((row) => row.session_id)).toContain(
      "cc--semantic-prior",
    );
  });

  it("downranks meta continuation hits below durable work in hybrid ranking", () => {
    const rows = mergeHybridRows(
      [],
      [
        similarRow("cur--meta-continuation", {
          title: "# Continuation prompt for next session",
          score: 0.98,
          embedding_score: 0.98,
          snippet:
            "Copy everything between the markers below into a new Cursor session",
          snippets: [
            {
              turn: 1,
              role: "chunk",
              snippet:
                "Copy everything between the markers below into a new Cursor session",
            },
          ],
        }),
        similarRow("cc--durable-prior", {
          title: "Implement current session exclusion in similar",
          score: 0.96,
          embedding_score: 0.96,
          snippet: "implemented current session exclusion and project scoping",
          snippets: [
            {
              turn: 1,
              role: "chunk",
              snippet:
                "implemented current session exclusion and project scoping",
            },
          ],
        }),
      ],
    );

    expect(rows[0]?.session_id).toBe("cc--durable-prior");
  });
});

function similarRow(
  sessionId: string,
  overrides: Partial<SimilarRow> = {},
): SimilarRow {
  return {
    session_id: sessionId,
    source: "claude-code",
    project_path: "/tmp/agentmine-embeddings",
    git_branch: null,
    title: sessionId,
    started_at: null,
    turn_count: 1,
    tool_call_count: 0,
    score: 1,
    matched_turns: 1,
    snippets: [{ turn: 1, role: "user", snippet: "lexical context" }],
    snippet: "lexical context",
    reconstruct_command: `agentmine session ${sessionId} --md`,
    ...overrides,
  };
}

describe("ollama provider error paths", () => {
  let dbPath: string;
  let tempDir: string;
  let db: DatabaseType;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-ollama-provider-"));
    dbPath = join(tempDir, "test.db");
    db = openDb({ path: dbPath });
    upsertSession(
      db,
      makeSession({
        id: "cc--ollama-provider",
        contentHash: "ollama-provider-v1",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "local embeddings test",
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

  it(
    "rejects unsupported ollama models before provider calls",
    async () => {
      const { exitCode, stdout } = await runCli(
        [
          "embed",
          "--provider",
          "ollama",
          "--model",
          "not-supported",
          "--dry-run",
        ],
        {
          AGENTMINE_DB: dbPath,
          AGENTMINE_OLLAMA_BASE_URL: "http://127.0.0.1:9",
        },
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("nomic-embed-text");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "reports unreachable ollama as a user/config error",
    async () => {
      const { exitCode, stdout } = await runCli(
        [
          "embed",
          "--provider",
          "ollama",
          "--model",
          "nomic-embed-text",
          "--limit",
          "1",
        ],
        {
          AGENTMINE_DB: dbPath,
          AGENTMINE_OLLAMA_BASE_URL: "http://127.0.0.1:9",
        },
      );
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("Ollama is not reachable");
    },
    CLI_TEST_TIMEOUT,
  );
});
