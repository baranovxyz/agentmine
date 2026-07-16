/**
 * Smoke test for the canonical seam:
 * the new parseClaudeCodeFile wrapper in canonical.ts routes through
 * agent-canonical's shared parser and projects to agentmine's flat
 * CanonicalSession shape.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseClaudeCodeFile,
  parseClineFile,
  parseCodexFile,
  parseGeminiFile,
  parseQwenFile,
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
