import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { openDb } from "../src/db/client.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 15_000;

const tempDirs: string[] = [];

function makeTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-sessions-where-test-"));
  tempDirs.push(dir);
  return join(dir, "sessions.db");
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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agentmine sessions --where (CLI)", () => {
  it(
    "matches a semicolon inside a LIKE predicate, a perfectly ordinary title",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "cc--fixture-semicolon-0001",
          title: "fix bug; add tests",
        }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({
          id: "cc--fixture-nosemicolon-0002",
          title: "fix bug and add tests",
        }),
      );
      db.close();

      const { exitCode, stdout } = await runCli(
        ["sessions", "--where", "title LIKE '%;%'"],
        dbPath,
      );
      expect(exitCode, stdout).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      const ids = parsed.data.rows.map((row: { id: string }) => row.id);
      expect(ids).toContain("cc--fixture-semicolon-0001");
      expect(ids).not.toContain("cc--fixture-nosemicolon-0002");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "fails loudly with an error envelope for invalid SQL",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({ id: "cc--fixture-invalid-where-0001" }),
      );
      db.close();

      const { exitCode, stdout } = await runCli(
        ["sessions", "--where", "this is not valid sql ("],
        dbPath,
      );
      expect(exitCode).not.toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBeTruthy();
      expect(parsed.errors[0].message).toBeTruthy();
    },
    CLI_TEST_TIMEOUT,
  );
});
