import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession, ToolCall } from "../src/adapters/types.js";
import { corpusLayout } from "../src/db/archives.js";
import { openDb } from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";
import { runAllExtractors } from "../src/extract/index.js";

const SKILL_LISTING_MARKER =
  "The following skills are available for use with the Skill tool";

function toolCall(name: string, args: unknown, index: number): ToolCall {
  return {
    name,
    args,
    argsHash: `hash-${index}`,
    argsPreview: "",
  };
}

function sessionWithFastPathFacts(
  id: string,
  revision: number,
): CanonicalSession {
  return {
    id,
    source: "claude-code",
    projectPath: "/tmp/fast-paths",
    contentHash: `${id}-revision-${revision}`,
    messages: [
      { turn: 1, role: "user", text: "exercise extractors", toolCalls: [] },
      {
        turn: 2,
        role: "assistant",
        text: "",
        toolCalls: [
          toolCall(
            "WebFetch",
            { url: `https://revision-${revision}.example/docs` },
            0,
          ),
          toolCall("Skill", { skill_id: `skill-${revision}` }, 1),
          toolCall(`mcp__server${revision}__tool`, {}, 2),
        ],
      },
    ],
    rawEvents: [
      {
        seq: 1,
        eventType: "attachment",
        rawJson: JSON.stringify({
          type: "attachment",
          attachment: {
            type: "skill_listing",
            isInitial: true,
            content: `- available-${revision}: revision ${revision}`,
          },
        }),
      },
    ],
  };
}

describe("extractor SQL fast paths", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentmine-fast-paths-"));
    dbPath = join(tempDir, "test.db");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps cold payload out of the hot database entirely", () => {
    // Payload was 75% of corpus bytes while no interactive command
    // read it, and its index pages were what made cold reads expensive. A
    // fresh corpus must therefore declare no payload table at all.
    const db = openDb({ path: dbPath });
    const payloadTables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('raw_events', 'tool_outputs')`,
      )
      .all();
    expect(payloadTables).toEqual([]);
    expect(corpusLayout(db)).toBe("split");
    db.close();
  });

  it("retains every supported web, skill, MCP, and skill-listing variant", () => {
    const db = openDb({ path: dbPath });
    const toolCalls: ToolCall[] = [];
    const add = (name: string, args: unknown): void => {
      toolCalls.push(toolCall(name, args, toolCalls.length));
    };

    add("WebFetch", { url: "https://web-fetch.example/docs" });
    add("webfetch", { URL: "https://webfetch.example/docs" });
    add("fetch", { href: "https://fetch.example/docs" });
    add("WebSearch", { query: "first search" });
    add("websearch", { q: "second search" });
    add("search", { search_term: "third search" });
    add("web_search", { queries: ["fourth search", "fallback"] });
    add("browser_navigate", { url: "https://browser.example/path" });
    add("Navigate", { href: "https://navigate.example/path" });

    add("Skill", { skill_id: "exact-title" });
    add("skill", { name: "exact-lower" });
    add("SKILL", { slug: "exact-upper" });
    add("skill_under", {});
    add("skill-hyphen", {});
    add("skill:colon", {});
    add("SKILL_mixed", {});
    add("Read", { file_path: "/repo/skills/indirect/SKILL.md" });

    add("mcp_tool", { server: "one", toolName: "alpha" });
    add("MCP_TOOL", { serverName: "two", name: "beta" });
    add("call_mcp_tool", { server_name: "three", tool_name: "gamma" });
    add("CALL_MCP_TOOL", { server: "four", tool: "delta" });
    add("CallMcpTool", { server: "five", toolName: "epsilon" });
    add("use_mcp_tool", { server_name: "six", tool_name: "zeta" });
    add("mcp__wiki__get_page", {});
    add("mcp_playwright_browser_click", {});

    add("unrelated", { url: "https://ignored.example", skill_id: "ignored" });

    upsertSessionWithPayload(db, {
      id: "cc--fast-path-variants",
      source: "claude-code",
      projectPath: "/tmp/fast-paths",
      contentHash: "fast-path-variants",
      messages: [
        { turn: 1, role: "user", text: "exercise variants", toolCalls: [] },
        { turn: 2, role: "assistant", text: "", toolCalls },
      ],
      rawEvents: [
        {
          seq: 10,
          eventType: "attachment",
          rawJson: JSON.stringify({
            type: "attachment",
            attachment: {
              type: "skill_listing",
              isInitial: false,
              content: `# Project
- attachment-only: attachment description
- shared: old description`,
            },
          }),
        },
        {
          seq: 20,
          eventType: "user",
          rawJson: JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: `${SKILL_LISTING_MARKER}
# User
- marker-string: string content
- shared: new description`,
            },
          }),
        },
        {
          seq: 30,
          eventType: "user",
          rawJson: JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${SKILL_LISTING_MARKER}
# Plugin
- marker-array: array content`,
                },
              ],
            },
          }),
        },
        {
          seq: 40,
          eventType: "assistant",
          rawJson: JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: `${SKILL_LISTING_MARKER}
- wrong-event-type: ignored`,
            },
          }),
        },
      ],
    });
    upsertSessionWithPayload(db, {
      id: "oc--skill-listing",
      source: "opencode",
      projectPath: "/tmp/fast-paths",
      contentHash: "non-claude-listing",
      messages: [],
      rawEvents: [
        {
          seq: 1,
          eventType: "attachment",
          rawJson: JSON.stringify({
            attachment: {
              type: "skill_listing",
              content: "- non-claude: ignored",
            },
          }),
        },
      ],
    });

    runAllExtractors(db);

    const webKinds = db
      .prepare<[], { kind: string }>(
        `SELECT kind FROM web_fetches
         WHERE session_id = 'cc--fast-path-variants' ORDER BY idx`,
      )
      .all()
      .map((row) => row.kind);
    expect(webKinds).toEqual([
      "fetch",
      "fetch",
      "fetch",
      "search",
      "search",
      "search",
      "search",
      "navigate",
      "navigate",
    ]);

    const skills = db
      .prepare<[], { skill_name: string }>(
        `SELECT skill_name FROM skills_invoked
         WHERE session_id = 'cc--fast-path-variants' ORDER BY skill_name`,
      )
      .all()
      .map((row) => row.skill_name);
    expect(skills).toEqual([
      "colon",
      "exact-lower",
      "exact-title",
      "exact-upper",
      "hyphen",
      "indirect",
      "mixed",
      "under",
    ]);

    const mcpCalls = db
      .prepare<[], { server: string; tool: string }>(
        `SELECT server, tool FROM mcp_calls
         WHERE session_id = 'cc--fast-path-variants' ORDER BY server`,
      )
      .all();
    expect(mcpCalls).toEqual([
      { server: "five", tool: "epsilon" },
      { server: "four", tool: "delta" },
      { server: "one", tool: "alpha" },
      { server: "playwright", tool: "browser_click" },
      { server: "six", tool: "zeta" },
      { server: "three", tool: "gamma" },
      { server: "two", tool: "beta" },
      { server: "wiki", tool: "get_page" },
    ]);

    const available = db
      .prepare<
        [],
        {
          session_id: string;
          skill_name: string;
          description: string;
          origin: string;
          is_initial: number;
        }
      >(
        `SELECT session_id, skill_name, description, origin, is_initial
           FROM skills_available ORDER BY skill_name`,
      )
      .all();
    expect(available).toEqual([
      {
        session_id: "cc--fast-path-variants",
        skill_name: "attachment-only",
        description: "attachment description",
        origin: "project",
        is_initial: 0,
      },
      {
        session_id: "cc--fast-path-variants",
        skill_name: "marker-array",
        description: "array content",
        origin: "plugin",
        is_initial: 1,
      },
      {
        session_id: "cc--fast-path-variants",
        skill_name: "marker-string",
        description: "string content",
        origin: "user",
        is_initial: 1,
      },
      {
        session_id: "cc--fast-path-variants",
        skill_name: "shared",
        description: "new description",
        origin: "user",
        is_initial: 1,
      },
    ]);
    db.close();
  });

  it("keeps scoped extraction equivalent to a full rebuild", () => {
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, sessionWithFastPathFacts("cc--scope-a", 1));
    upsertSessionWithPayload(db, sessionWithFastPathFacts("cc--scope-b", 1));
    runAllExtractors(db);

    upsertSessionWithPayload(db, sessionWithFastPathFacts("cc--scope-a", 2));
    runAllExtractors(db, ["cc--scope-a"]);
    const scoped = snapshotFastPathFacts(db);

    runAllExtractors(db);
    expect(scoped).toEqual(snapshotFastPathFacts(db));
    db.close();
  });
});

function snapshotFastPathFacts(
  db: ReturnType<typeof openDb>,
): Record<string, Array<Record<string, unknown>>> {
  return {
    skills_invoked: db
      .prepare<[], Record<string, unknown>>(
        `SELECT * FROM skills_invoked ORDER BY session_id, turn, idx`,
      )
      .all(),
    skills_available: db
      .prepare<[], Record<string, unknown>>(
        `SELECT * FROM skills_available ORDER BY session_id, skill_name`,
      )
      .all(),
    mcp_calls: db
      .prepare<[], Record<string, unknown>>(
        `SELECT * FROM mcp_calls ORDER BY session_id, turn, idx`,
      )
      .all(),
    web_fetches: db
      .prepare<[], Record<string, unknown>>(
        `SELECT * FROM web_fetches ORDER BY session_id, turn, idx`,
      )
      .all(),
  };
}
