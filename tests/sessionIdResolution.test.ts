import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { resolveSessionId } from "../src/commands/session.js";
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
  const dir = mkdtempSync(join(tmpdir(), "agentmine-session-id-test-"));
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

describe("resolveSessionId", () => {
  it("resolves an exact match without touching the fallback ladder", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, makeSession({ id: "cc--exact-match" }));

    expect(resolveSessionId(db, "cc--exact-match")).toEqual({
      id: "cc--exact-match",
    });
    db.close();
  });

  it("resolves a unique truncated-id prefix", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, makeSession({ id: "cc--fixture-alpha-0001" }));

    expect(resolveSessionId(db, "cc--fixture-alpha")).toEqual({
      id: "cc--fixture-alpha-0001",
    });
    db.close();
  });

  it("resolves a bare external id missing its source prefix", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    const externalId = "fixture-external-0007";
    upsertSessionWithPayload(
      db,
      makeSession({ id: "cc--session-with-external-id", externalId }),
    );

    expect(resolveSessionId(db, externalId)).toEqual({
      id: "cc--session-with-external-id",
    });
    db.close();
  });

  it("resolves an id missing its source prefix via the trailing suffix", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, makeSession({ id: "cx--019fec59abcdef" }));

    expect(resolveSessionId(db, "019fec59abcdef")).toEqual({
      id: "cx--019fec59abcdef",
    });
    db.close();
  });

  it("reports AMBIGUOUS candidates when a prefix matches more than one session", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, makeSession({ id: "cc--shared-prefix-aaaa" }));
    upsertSessionWithPayload(db, makeSession({ id: "cc--shared-prefix-bbbb" }));

    const resolution = resolveSessionId(db, "cc--shared-prefix");
    expect(resolution).not.toBeNull();
    expect(resolution && "candidates" in resolution).toBe(true);
    if (resolution && "candidates" in resolution) {
      expect(resolution.candidates.sort()).toEqual([
        "cc--shared-prefix-aaaa",
        "cc--shared-prefix-bbbb",
      ]);
    }
    db.close();
  });

  it("goes straight to not-found for a pathologically short input", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(
      db,
      makeSession({ id: "cd--session-that-exists" }),
    );

    // A stray shell argument like `cd` must not trigger a prefix scan.
    expect(resolveSessionId(db, "cd")).toBeNull();
    db.close();
  });

  it("reports not-found when nothing matches at all", () => {
    const dbPath = makeTempDbPath();
    const db = openDb({ path: dbPath });
    upsertSessionWithPayload(db, makeSession({ id: "cc--unrelated-session" }));

    expect(resolveSessionId(db, "cc--totally-nonexistent-id")).toBeNull();
    db.close();
  });
});

describe("agentmine session <id> lenient resolution (CLI)", () => {
  it(
    "resolves a truncated id and reports SESSION_ID_RESOLVED",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({ id: "cc--fixture-alpha-0002" }),
      );
      db.close();

      const { exitCode, stdout } = await runCli(
        ["session", "cc--fixture-alpha"],
        dbPath,
      );
      expect(exitCode, stdout).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("success");
      expect(parsed.data.session.id).toBe("cc--fixture-alpha-0002");
      expect(parsed.warnings).toContainEqual({
        name: "SESSION_ID_RESOLVED",
        message:
          "Resolved 'cc--fixture-alpha' to session " +
          "'cc--fixture-alpha-0002'.",
      });
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "resolves a bare external id and reports SESSION_ID_RESOLVED",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      const externalId = "fixture-external-0007";
      upsertSessionWithPayload(
        db,
        makeSession({ id: "cc--has-external-id", externalId }),
      );
      db.close();

      const { exitCode, stdout } = await runCli(
        ["session", externalId],
        dbPath,
      );
      expect(exitCode, stdout).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.session.id).toBe("cc--has-external-id");
      expect(parsed.warnings).toContainEqual(
        expect.objectContaining({ name: "SESSION_ID_RESOLVED" }),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "fails with INVALID_INPUT naming the candidates for an ambiguous prefix",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(
        db,
        makeSession({ id: "cc--shared-prefix-aaaa" }),
      );
      upsertSessionWithPayload(
        db,
        makeSession({ id: "cc--shared-prefix-bbbb" }),
      );
      db.close();

      const { exitCode, stdout } = await runCli(
        ["session", "cc--shared-prefix"],
        dbPath,
      );
      expect(exitCode).not.toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("cc--shared-prefix");
      expect(parsed.errors[0].message).toContain("cc--shared-prefix-aaaa");
      expect(parsed.errors[0].message).toContain("cc--shared-prefix-bbbb");
      expect(parsed.errors[0].message).toContain("ambiguous");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "fails with an actionable NOT_FOUND for a two-character input",
    async () => {
      const dbPath = makeTempDbPath();
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(db, makeSession({ id: "cc--unrelated" }));
      db.close();

      const { exitCode, stdout } = await runCli(["session", "cd"], dbPath);
      expect(exitCode).not.toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("NOT_FOUND");
      expect(parsed.errors[0].message).toContain("'cd'");
      expect(parsed.errors[0].message).toContain(
        "agentmine sessions --limit 20",
      );
      expect(parsed.errors[0].message).toContain("cc--<uuid>");
    },
    CLI_TEST_TIMEOUT,
  );
});
