/**
 * Smoke test for the canonical seam:
 * the new parseClaudeCodeFile wrapper in canonical.ts routes through
 * agent-canonical's shared parser and projects to agentmine's flat
 * CanonicalSession shape.
 */

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseClaudeCodeFile,
  parseClineFile,
  parseCodexFile,
  parseCopilotFile,
  parseDroidFile,
  parseGeminiFile,
  parsePiFile,
  parseQwenFile,
  parseVibeFile,
} from "../src/adapters/canonical.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "fixtures", "claude-code", "tiny.jsonl");
const CODEX_FIXTURE_DIR = join(__dirname, "fixtures", "codex");
const GEMINI_FIXTURE = join(__dirname, "fixtures", "gemini", "tiny.jsonl");
const QWEN_FIXTURE = join(__dirname, "fixtures", "qwen", "tiny.jsonl");
const CLINE_FIXTURE = join(
  __dirname,
  "fixtures",
  "cline",
  "fixture-001",
  "fixture-001.messages.json",
);
const COPILOT_FIXTURE = join(
  __dirname,
  "fixtures",
  "copilot",
  "fixture-001",
  "events.jsonl",
);
const PI_FIXTURE = join(
  __dirname,
  "fixtures",
  "pi",
  "fixture-project",
  "2026-01-01T00-00-00-000Z_fixture-001.jsonl",
);
const DROID_FIXTURE = join(
  __dirname,
  "fixtures",
  "droid",
  "fixture-project",
  "fixture-001.jsonl",
);
const VIBE_FIXTURE = join(
  __dirname,
  "fixtures",
  "vibe",
  "session_20260101_000000_fixture0",
  "messages.jsonl",
);

describe("canonical seam — parseClaudeCodeFile (shared parser via canonical.ts)", () => {
  it("returns a flat CanonicalSession (not null)", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session).not.toBeNull();
  });

  it("produces source 'claude-code'", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session?.source).toBe("claude-code");
  });

  it("produces id with default 'cc--' prefix", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session?.id).toMatch(/^cc--/);
  });

  it("contains non-empty messages", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session?.messages.length).toBeGreaterThan(0);
  });

  it("produces a SHA-256 content hash", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("respects opts.idPrefix override", async () => {
    const session = await parseClaudeCodeFile(FIXTURE, { idPrefix: "test" });
    expect(session?.id).toMatch(/^test--/);
  });

  it("respects opts.source override", async () => {
    const session = await parseClaudeCodeFile(FIXTURE, {
      source: "cursor-agent-file",
    });
    expect(session?.source).toBe("cursor-agent-file");
  });

  it("tiny fixture: session id is cc--fixture-001", async () => {
    const session = await parseClaudeCodeFile(FIXTURE);
    expect(session?.id).toBe("cc--fixture-001");
  });
});

describe("canonical seam — parseCodexFile lineage", () => {
  it.each([
    {
      kind: "root",
      fixture: "lineage-root.jsonl",
      id: "cx--lineage-root-001",
      parentSessionId: undefined,
      agentType: undefined,
    },
    {
      kind: "role-based worker",
      fixture: "lineage-role-worker.jsonl",
      id: "cx--lineage-role-worker-001",
      parentSessionId: "cx--lineage-root-001",
      agentType: "researcher",
    },
    {
      kind: "nested path-based worker",
      fixture: "lineage-path-worker.jsonl",
      id: "cx--lineage-path-worker-001",
      parentSessionId: "cx--lineage-role-worker-001",
      agentType: "/root/research/verification",
    },
    {
      kind: "Guardian child",
      fixture: "lineage-guardian.jsonl",
      id: "cx--lineage-guardian-001",
      parentSessionId: "cx--lineage-path-worker-001",
      agentType: "guardian",
    },
  ])("preserves canonical identity and direct lineage for a $kind", async ({
    fixture,
    id,
    parentSessionId,
    agentType,
  }) => {
    const session = await parseCodexFile(join(CODEX_FIXTURE_DIR, fixture));

    expect(session).not.toBeNull();
    expect(session?.source).toBe("codex");
    expect(session?.id).toBe(id);
    expect(session?.parentSessionId).toBe(parentSessionId);
    expect(session?.agentType).toBe(agentType);
  });

  it("rejects malformed negative token counters from the shared parser", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-negative-codex-"));
    const fixture = join(dir, "negative.jsonl");
    try {
      writeFileSync(
        fixture,
        [
          {
            timestamp: "2026-07-01T10:00:00.000Z",
            type: "session_meta",
            payload: { id: "negative-usage", cwd: "/workspace/example" },
          },
          {
            timestamp: "2026-07-01T10:00:01.000Z",
            type: "turn_context",
            payload: { turn_id: "t1", model: "gpt-5.4" },
          },
          {
            timestamp: "2026-07-01T10:00:02.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "price this session" }],
            },
          },
          {
            timestamp: "2026-07-01T10:00:03.000Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: -100,
                  output_tokens: -10,
                  cached_input_tokens: -80,
                },
              },
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      );

      await expect(parseCodexFile(fixture)).rejects.toThrow(/inputTokens/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canonical seam — parseGeminiFile (shared parser via canonical.ts)", () => {
  it("returns a flat CanonicalSession with source 'gemini' and 'gm--' id", async () => {
    const session = await parseGeminiFile(GEMINI_FIXTURE);
    expect(session).not.toBeNull();
    expect(session?.source).toBe("gemini");
    expect(session?.id).toBe("gm--fixture-001");
  });

  it("hoists messages, model, project path, and a content hash", async () => {
    const session = await parseGeminiFile(GEMINI_FIXTURE);
    expect(session?.messages.length).toBe(2);
    expect(session?.model).toBe("gemini-2.5-pro");
    expect(session?.projectPath).toBe("/home/u/proj");
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.inputTokens).toBe(42);
  });
});

describe("canonical seam — parseQwenFile (shared parser via canonical.ts)", () => {
  it("returns a flat CanonicalSession with source, model, usage, and tool output", async () => {
    const session = await parseQwenFile(QWEN_FIXTURE);
    expect(session).not.toBeNull();
    expect(session?.source).toBe("qwen");
    expect(session?.id).toBe("qw--fixture-qwen-001");
    expect(session?.model).toBe("qwen/qwen3-coder");
    expect(session?.inputTokens).toBe(11);
    expect(
      session?.messages.flatMap((message) => message.toolCalls),
    ).toHaveLength(1);
    expect(
      session?.messages.flatMap((message) => message.toolCalls)[0]?.outputFull,
    ).toBe("README.md");
  });
});

describe("canonical seam — parseClineFile (shared parser via canonical.ts)", () => {
  it("flattens a Cline file pair with identity, metadata, and usage", async () => {
    const session = await parseClineFile(CLINE_FIXTURE);

    expect(session).not.toBeNull();
    expect(session?.source).toBe("cline");
    expect(session?.id).toBe("cline--fixture-001");
    expect(session?.projectPath).toBe("/home/example/sample-project");
    expect(session?.model).toBe("model-placeholder");
    expect(session?.messages).toHaveLength(2);
    expect(session?.inputTokens).toBe(12);
    expect(session?.outputTokens).toBe(6);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("canonical seam — parseCopilotFile (shared parser via canonical.ts)", () => {
  it("flattens a Copilot events.jsonl with identity, metadata, and usage", async () => {
    const session = await parseCopilotFile(COPILOT_FIXTURE);

    expect(session).not.toBeNull();
    expect(session?.source).toBe("copilot");
    expect(session?.id).toBe("copilot--fixture-001");
    expect(session?.projectPath).toBe("/home/example/sample-project");
    expect(session?.gitBranch).toBe("main");
    expect(session?.model).toBe("model-placeholder");
    // user, tool-issuing assistant, final assistant.
    expect(session?.messages).toHaveLength(3);
    // Totals come from the session.shutdown modelMetrics aggregate.
    expect(session?.inputTokens).toBe(12);
    expect(session?.outputTokens).toBe(6);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("canonical seam — parsePiFile (shared parser via canonical.ts)", () => {
  it("flattens a Pi session JSONL with identity, metadata, and usage", async () => {
    const session = await parsePiFile(PI_FIXTURE);

    expect(session).not.toBeNull();
    expect(session?.source).toBe("pi");
    expect(session?.id).toBe("pi--fixture-001");
    expect(session?.projectPath).toBe("/home/example/sample-project");
    expect(session?.model).toBe("model-placeholder");
    expect(session?.title).toBe("pi-fixture-session");
    // user, split-out thinking, tool-issuing assistant, final assistant.
    expect(session?.messages.map((message) => message.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "assistant",
    ]);
    // Per-assistant-message usage sums across the session.
    expect(session?.inputTokens).toBe(32);
    expect(session?.outputTokens).toBe(14);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("correlates the tool result back onto its assistant tool call", async () => {
    const session = await parsePiFile(PI_FIXTURE);
    const toolCalls = session?.messages.flatMap((message) => message.toolCalls);

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls?.[0]?.name).toBe("bash");
    expect(toolCalls?.[0]?.callId).toBe("call_fixture_1");
    expect(toolCalls?.[0]?.outputFull).toBe("README.md");
  });
});

describe("canonical seam — parseDroidFile (shared parser via canonical.ts)", () => {
  it("flattens a Droid JSONL + settings sibling with identity, metadata, and usage", async () => {
    const session = await parseDroidFile(DROID_FIXTURE);

    expect(session).not.toBeNull();
    expect(session?.source).toBe("droid");
    expect(session?.id).toBe("droid--fixture-001");
    expect(session?.projectPath).toBe("/home/example/sample-project");
    expect(session?.title).toBe("Sample droid session");
    // The settings sibling is the only source of the model alias and totals.
    expect(session?.model).toBe("model-placeholder");
    expect(session?.inputTokens).toBe(12);
    expect(session?.outputTokens).toBe(6);
    expect(session?.cacheReadTokens).toBe(4);
    expect(session?.cacheCreationTokens).toBe(2);
    expect(session?.reasoningTokens).toBe(3);
    expect(session?.messages.map((message) => message.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "assistant",
    ]);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("folds the settings sibling into the ingest cache key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-droid-sidecar-"));
    try {
      const sessionPath = join(dir, "fixture-001.jsonl");
      const settingsPath = join(dir, "fixture-001.settings.json");
      copyFileSync(DROID_FIXTURE, sessionPath);
      copyFileSync(
        join(dirname(DROID_FIXTURE), "fixture-001.settings.json"),
        settingsPath,
      );

      const before = await parseDroidFile(sessionPath);
      writeFileSync(
        settingsPath,
        JSON.stringify({
          model: "model-placeholder",
          tokenUsage: { inputTokens: 99, outputTokens: 6 },
        }),
      );
      const after = await parseDroidFile(sessionPath);

      // The transcript is byte-identical, so only the sidecar mixing can move
      // the hash — without it a settings-only update would be skipped as cached.
      expect(after?.inputTokens).toBe(99);
      expect(after?.contentHash).not.toBe(before?.contentHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("canonical seam — parseVibeFile (shared parser via canonical.ts)", () => {
  it("flattens a Vibe messages.jsonl + meta.json with identity, metadata, and usage", async () => {
    const session = await parseVibeFile(VIBE_FIXTURE);

    expect(session).not.toBeNull();
    expect(session?.source).toBe("vibe");
    expect(session?.id).toBe("vibe--fixture-001");
    expect(session?.projectPath).toBe("/home/example/sample-project");
    expect(session?.gitBranch).toBe("main");
    expect(session?.title).toBe("Sample vibe session");
    // The model is only recoverable through config.models[active_model].name.
    expect(session?.model).toBe("model-placeholder");
    expect(session?.inputTokens).toBe(12);
    expect(session?.outputTokens).toBe(6);
    expect(session?.cacheReadTokens).toBe(4);
    expect(session?.messages.map((message) => message.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "assistant",
    ]);
    expect(session?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("accepts the session directory as well as its messages.jsonl", async () => {
    const fromDir = await parseVibeFile(dirname(VIBE_FIXTURE));
    const fromFile = await parseVibeFile(VIBE_FIXTURE);

    expect(fromDir?.id).toBe(fromFile?.id);
    expect(fromDir?.contentHash).toBe(fromFile?.contentHash);
  });

  it("folds the meta.json sidecar into the ingest cache key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-vibe-sidecar-"));
    try {
      const sessionDir = join(dir, "session_20260101_000000_fixture0");
      mkdirSync(sessionDir, { recursive: true });
      const messagesPath = join(sessionDir, "messages.jsonl");
      const metaPath = join(sessionDir, "meta.json");
      copyFileSync(VIBE_FIXTURE, messagesPath);
      copyFileSync(join(dirname(VIBE_FIXTURE), "meta.json"), metaPath);

      const before = await parseVibeFile(messagesPath);
      writeFileSync(
        metaPath,
        JSON.stringify({
          session_id: "fixture-001",
          stats: { session_prompt_tokens: 99, session_completion_tokens: 6 },
        }),
      );
      const after = await parseVibeFile(messagesPath);

      expect(after?.inputTokens).toBe(99);
      expect(after?.contentHash).not.toBe(before?.contentHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
