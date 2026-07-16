import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { openDb } from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";

// Round-trip proof: per-message token usage is persisted
// during ingest (not only summed into the session total), so a skill span can
// be summed message-by-message. A source lacking per-message usage stores NULL
// rather than a wrong number.

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-msg-usage-"));
  return join(dir, "test.db");
}

interface UsageRow {
  turn: number;
  role: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  reasoning_tokens: number | null;
}

describe("per-message token usage persistence", () => {
  const dbPaths: string[] = [];
  afterEach(() => {
    for (const p of dbPaths.splice(0))
      rmSync(dirname(p), { recursive: true, force: true });
  });

  function withDb(session: CanonicalSession): UsageRow[] {
    const dbPath = tmpDbPath();
    dbPaths.push(dbPath);
    const db = openDb({ path: dbPath });
    upsertSession(db, session);
    const rows = db
      .prepare<[string], UsageRow>(
        `SELECT turn, role, input_tokens, output_tokens, cache_read_tokens,
                cache_creation_tokens, reasoning_tokens
           FROM messages WHERE session_id = ? ORDER BY turn`,
      )
      .all(session.id);
    db.close();
    return rows;
  }

  it("writes the per-message usage columns for assistant turns and NULL for user turns", () => {
    const session: CanonicalSession = {
      id: `cc--${randomUUID()}`,
      source: "claude-code",
      contentHash: randomUUID(),
      messages: [
        { turn: 1, role: "user", text: "hello", toolCalls: [] },
        {
          turn: 2,
          role: "assistant",
          text: "reply",
          toolCalls: [],
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 2000,
            cacheCreationTokens: 1000,
          },
        },
      ],
    };

    const rows = withDb(session);
    expect(rows).toHaveLength(2);

    const user = rows.find((r) => r.role === "user")!;
    expect(user.input_tokens).toBeNull();
    expect(user.output_tokens).toBeNull();
    expect(user.cache_read_tokens).toBeNull();
    expect(user.cache_creation_tokens).toBeNull();
    expect(user.reasoning_tokens).toBeNull();

    const asst = rows.find((r) => r.role === "assistant")!;
    expect(asst.input_tokens).toBe(100);
    expect(asst.output_tokens).toBe(50);
    expect(asst.cache_read_tokens).toBe(2000);
    expect(asst.cache_creation_tokens).toBe(1000);
    // claude-code does not report reasoning tokens.
    expect(asst.reasoning_tokens).toBeNull();
  });

  it("persists reasoning tokens when the source provides them (opencode)", () => {
    const session: CanonicalSession = {
      id: `oc--${randomUUID()}`,
      source: "opencode",
      contentHash: randomUUID(),
      messages: [
        {
          turn: 1,
          role: "assistant",
          text: "reply",
          toolCalls: [],
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            reasoningTokens: 5,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
          },
        },
      ],
    };

    const [asst] = withDb(session);
    expect(asst?.reasoning_tokens).toBe(5);
    expect(asst?.input_tokens).toBe(100);
    expect(asst?.cache_creation_tokens).toBe(10);
  });

  it("leaves all usage columns NULL for a usage-blind source", () => {
    const session: CanonicalSession = {
      id: `cx--${randomUUID()}`,
      source: "codex",
      contentHash: randomUUID(),
      messages: [{ turn: 1, role: "assistant", text: "reply", toolCalls: [] }],
    };

    const [asst] = withDb(session);
    expect(asst?.input_tokens).toBeNull();
    expect(asst?.output_tokens).toBeNull();
    expect(asst?.cache_read_tokens).toBeNull();
    expect(asst?.cache_creation_tokens).toBeNull();
    expect(asst?.reasoning_tokens).toBeNull();
  });
});
