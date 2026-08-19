import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { sanitizeFtsQuery } from "../src/commands/fts.js";
import { openDb } from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 15_000;

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-fts-sanitize-test-"));
  return join(dir, "test.db");
}

function makeSession(
  overrides: Partial<CanonicalSession> = {},
): CanonicalSession {
  return {
    id: `cc--${randomUUID()}`,
    source: "claude-code",
    projectPath: "/tmp/proj",
    messages: [],
    contentHash: randomUUID(),
    ...overrides,
  };
}

async function runCli(args: string[], dbPath: string) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: REPO,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", AGENTMINE_DB: dbPath },
  });
}

describe("sanitizeFtsQuery (pure unit tests)", () => {
  it("wraps a single hyphenated bareword in quotes", () => {
    expect(sanitizeFtsQuery("no-show")).toBe('"no-show"');
  });

  it("leaves a safe bareword alone and quotes only the hyphenated one", () => {
    expect(sanitizeFtsQuery("autoweb no-show")).toBe('autoweb "no-show"');
  });

  it("copies an already-quoted span through verbatim", () => {
    expect(sanitizeFtsQuery('"already quoted" x')).toBe('"already quoted" x');
  });

  it("leaves an uppercase AND operator between safe barewords unchanged", () => {
    expect(sanitizeFtsQuery("foo AND bar")).toBe("foo AND bar");
  });

  it("leaves a prefix-search bareword unchanged", () => {
    expect(sanitizeFtsQuery("foo*")).toBe("foo*");
  });

  it("quotes a hyphenated prefix search, keeping the trailing * outside the quotes", () => {
    expect(sanitizeFtsQuery("co-op*")).toBe('"co-op"*');
  });

  it("quotes only the hyphenated bareword next to a real operator", () => {
    expect(sanitizeFtsQuery("a AND b-c")).toBe('a AND "b-c"');
  });

  it("preserves parentheses while quoting the unsafe bareword inside", () => {
    expect(sanitizeFtsQuery("(no-show)")).toBe('("no-show")');
  });

  it("treats a lowercase and/or as a plain term, not an operator", () => {
    expect(sanitizeFtsQuery("foo and bar")).toBe("foo and bar");
  });

  it("returns the original string when sanitizing would produce an empty query", () => {
    expect(sanitizeFtsQuery("   ")).toBe("   ");
  });

  it("is idempotent: sanitizing twice equals sanitizing once", () => {
    const once = sanitizeFtsQuery("autoweb no-show offer-triple pattern");
    const twice = sanitizeFtsQuery(once);
    expect(twice).toBe(once);
  });
});

describe("agentmine fts sanitize-and-retry (end-to-end)", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({
        id: "s-no-show",
        messages: [
          {
            turn: 1,
            role: "user",
            text: "autoweb no-show",
            toolCalls: [],
          },
        ],
      }),
    );
    db.close();
  });

  afterEach(() => {
    rmSync(dbPath, { force: true, recursive: true });
  });

  it(
    "retries a raw hyphenated query and returns the match with a QUERY_SANITIZED warning",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["fts", "autoweb no-show"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.row_count).toBe(1);
      expect(parsed.data.query).toBe('autoweb "no-show"');
      expect(parsed.data.raw_query).toBe("autoweb no-show");
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({
          name: "QUERY_SANITIZED",
          message: expect.stringContaining('autoweb "no-show"'),
        }),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "runs a valid quoted-phrase query on the fast path without any warning",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["fts", '"autoweb" "no-show"'],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.row_count).toBe(1);
      expect(parsed.data.query).toBe('"autoweb" "no-show"');
      expect(parsed.data.raw_query).toBeUndefined();
      expect(parsed.warnings ?? []).toEqual([]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "runs a valid query with an explicit column filter on the fast path without any warning",
    async () => {
      const { exitCode, stdout } = await runCli(
        ["fts", "text:autoweb"],
        dbPath,
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.row_count).toBe(1);
      expect(parsed.data.query).toBe("text:autoweb");
      expect(parsed.data.raw_query).toBeUndefined();
      expect(parsed.warnings ?? []).toEqual([]);
    },
    CLI_TEST_TIMEOUT,
  );
});
