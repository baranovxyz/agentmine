import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCodexFile } from "../src/adapters/canonical.js";
import {
  CODEX_LINEAGE_BACKFILL_META_KEY,
  getMeta,
  openDb,
  upsertMeta,
} from "../src/db/client.js";
import { upsertSession } from "../src/db/writer.js";
import { runAllExtractors } from "../src/extract/index.js";
import { VERSION } from "../src/version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 15_000;
const CLINE_FIXTURE_DIR = join(__dirname, "fixtures", "cline", "fixture-001");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
  cwd = REPO,
) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd,
    reject: false,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

function parseUsageCommands(help: string): string[] {
  const usage = help.match(/^USAGE agentmine (.+)$/mu)?.[1];
  if (usage === undefined) throw new Error("Missing root command usage line");
  return usage.split("|").map((command) => command.trim());
}

describe("cli envelope", () => {
  it("emits a CliResult envelope on schema command, exit 0", async () => {
    const { exitCode, stdout } = await runCli(["schema"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("success");
    expect(parsed.command).toBe("agentmine schema");
    expect(typeof parsed.traceId).toBe("string");
    expect(parsed.data.tool).toBe("agentmine");
    expect(parsed.data.outputVersion).toBe(1);
    expect(parsed.data.exitCodes["0"]).toBe("Success");
    expect(parsed.data.commands.schema).toBeTruthy();
  });

  it("reports Node runtime metadata without changing --version output", async () => {
    const [{ exitCode, stdout }, plain] = await Promise.all([
      runCli(["version"]),
      runCli(["--version"]),
    ]);
    expect(exitCode).toBe(0);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout.trim()).toBe(VERSION);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({
      version: 1,
      status: "success",
      command: "agentmine version",
      data: {
        agentmine_version: VERSION,
        runtime: "node",
        runtime_version: process.versions.node,
        target: null,
        bun_version: null,
        source_commit: null,
      },
    });
  });

  it("stderr stays clean on success (no stdout pollution)", async () => {
    const { stdout } = await runCli(["schema"]);
    // stdout must parse as exactly one JSON object, no prefix/suffix
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("gives live-database recovery for an empty Kilo source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-empty-kilo-"));
    try {
      const { exitCode, stdout } = await runCli(
        ["normalize", "--source", "kilo"],
        { HOME: dir, XDG_DATA_HOME: join(dir, "data") },
      );
      expect(exitCode).toBe(2);
      expect(stdout).toContain(
        "Check that the live SQLite database for kilo exists and contains sessions.",
      );
      expect(stdout).not.toContain("agentmine sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives live-database recovery for an empty Goose source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-empty-goose-"));
    try {
      const { exitCode, stdout } = await runCli(
        ["normalize", "--source", "goose"],
        { HOME: dir, XDG_DATA_HOME: join(dir, "data") },
      );
      expect(exitCode).toBe(2);
      expect(stdout).toContain(
        "Check that the live SQLite database for goose exists and contains sessions.",
      );
      expect(stdout).not.toContain("agentmine sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ingests Cline root, subagent, and team-task artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-cline-ingest-"));
    const home = join(dir, "home");
    const dataRoot = join(dir, "data");
    const clineSessionsDir = join(dir, "cline-sessions");
    const sourceDir = join(clineSessionsDir, "fixture-001");
    const dbPath = join(dir, "sessions.db");

    try {
      mkdirSync(sourceDir, { recursive: true });
      for (const name of [
        "fixture-001.messages.json",
        "fixture-001.json",
        "subagent-placeholder.messages.json",
        "team-agent-placeholder__task-placeholder.messages.json",
      ]) {
        copyFileSync(join(CLINE_FIXTURE_DIR, name), join(sourceDir, name));
      }
      writeFileSync(join(sourceDir, "empty.messages.json"), "");

      const { exitCode, stdout } = await runCli(
        ["ingest", "--source", "cline"],
        {
          HOME: home,
          XDG_DATA_HOME: dataRoot,
          CLINE_SESSION_DATA_DIR: clineSessionsDir,
          AGENTMINE_DB: dbPath,
        },
      );

      expect(exitCode).toBe(0);
      const receipt = z
        .object({
          data: z.object({
            steps: z.array(z.object({ step: z.string() }).passthrough()),
          }),
        })
        .parse(JSON.parse(stdout.trim()));
      expect(receipt.data.steps.map((step) => step.step)).toEqual([
        "sync",
        "normalize",
        "extract",
      ]);
      expect(
        existsSync(
          join(
            dataRoot,
            "agentmine",
            "sessions",
            "cline",
            "fixture-001",
            "fixture-001.messages.json",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            dataRoot,
            "agentmine",
            "sessions",
            "cline",
            "fixture-001",
            "subagent-placeholder.messages.json",
          ),
        ),
      ).toBe(true);
      expect(
        existsSync(
          join(
            dataRoot,
            "agentmine",
            "sessions",
            "cline",
            "fixture-001",
            "team-agent-placeholder__task-placeholder.messages.json",
          ),
        ),
      ).toBe(true);
      // Current Cline writes metadata only for the root session. Child and
      // team-task artifacts are messages-only siblings with composite IDs.
      expect(
        existsSync(
          join(
            dataRoot,
            "agentmine",
            "sessions",
            "cline",
            "fixture-001",
            "subagent-placeholder.json",
          ),
        ),
      ).toBe(false);

      const db = openDb({ readonly: true, init: false, path: dbPath });
      try {
        const sessions = db
          .prepare<
            [],
            { id: string; source: string; project_path: string | null }
          >(
            "SELECT id, source, project_path FROM sessions WHERE source = 'cline' ORDER BY id",
          )
          .all();
        expect(sessions).toEqual([
          {
            id: "cline--fixture-001",
            source: "cline",
            project_path: "/home/example/sample-project",
          },
          {
            id: "cline--fixture-001__subagent-placeholder",
            source: "cline",
            project_path: null,
          },
          {
            id: "cline--fixture-001__teamtask__team-agent-placeholder__task-placeholder",
            source: "cline",
            project_path: null,
          },
        ]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("refreshes Cline rows when only root metadata changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentmine-cline-metadata-"));
    const dataRoot = join(dir, "data");
    const rawSessionDir = join(
      dataRoot,
      "agentmine",
      "sessions",
      "cline",
      "fixture-001",
    );
    const messagesPath = join(rawSessionDir, "fixture-001.messages.json");
    const metadataPath = join(rawSessionDir, "fixture-001.json");
    const dbPath = join(dir, "sessions.db");
    const oldMtime = new Date("2020-01-01T00:00:00Z");
    const receiptSchema = z.object({
      data: z
        .object({
          files_scanned: z.number(),
          processed: z.number(),
          skipped_up_to_date: z.number(),
        })
        .passthrough(),
    });

    try {
      mkdirSync(rawSessionDir, { recursive: true });
      copyFileSync(
        join(CLINE_FIXTURE_DIR, "fixture-001.messages.json"),
        messagesPath,
      );
      copyFileSync(join(CLINE_FIXTURE_DIR, "fixture-001.json"), metadataPath);
      utimesSync(messagesPath, oldMtime, oldMtime);
      utimesSync(metadataPath, oldMtime, oldMtime);

      const initial = await runCli(["normalize", "--source", "cline"], {
        HOME: dir,
        XDG_DATA_HOME: dataRoot,
        AGENTMINE_DB: dbPath,
      });
      expect(initial.exitCode).toBe(0);
      expect(
        receiptSchema.parse(JSON.parse(initial.stdout.trim())).data,
      ).toMatchObject({
        files_scanned: 1,
        processed: 1,
        skipped_up_to_date: 0,
      });

      const beforeDb = openDb({ readonly: true, init: false, path: dbPath });
      const before = beforeDb
        .prepare<
          [string],
          {
            content_hash: string;
            model: string | null;
            project_path: string | null;
            title: string | null;
          }
        >(
          "SELECT content_hash, model, project_path, title FROM sessions WHERE id = ?",
        )
        .get("cline--fixture-001");
      beforeDb.close();
      expect(before).toMatchObject({
        model: "model-placeholder",
        project_path: "/home/example/sample-project",
        title: "Summarize the sample project.",
      });

      copyFileSync(
        join(CLINE_FIXTURE_DIR, "fixture-001.updated.json"),
        metadataPath,
      );
      const freshMtime = new Date();
      utimesSync(metadataPath, freshMtime, freshMtime);
      utimesSync(messagesPath, oldMtime, oldMtime);

      const refreshed = await runCli(
        ["normalize", "--source", "cline", "--since", "1d"],
        {
          HOME: dir,
          XDG_DATA_HOME: dataRoot,
          AGENTMINE_DB: dbPath,
        },
      );
      expect(refreshed.exitCode).toBe(0);
      expect(
        receiptSchema.parse(JSON.parse(refreshed.stdout.trim())).data,
      ).toMatchObject({
        files_scanned: 1,
        processed: 1,
        skipped_up_to_date: 0,
      });

      const afterDb = openDb({ readonly: true, init: false, path: dbPath });
      const after = afterDb
        .prepare<
          [string],
          {
            content_hash: string;
            model: string | null;
            project_path: string | null;
            title: string | null;
          }
        >(
          "SELECT content_hash, model, project_path, title FROM sessions WHERE id = ?",
        )
        .get("cline--fixture-001");
      const rawMetadata = afterDb
        .prepare<[string], { raw_json: string }>(
          "SELECT raw_json FROM raw_events WHERE session_id = ? AND event_type = 'session'",
        )
        .get("cline--fixture-001");
      afterDb.close();

      expect(after).toMatchObject({
        model: "updated-model-placeholder",
        project_path: "/home/example/updated-sample-project",
        title: "Summarize the updated sample project.",
      });
      expect(after?.content_hash).not.toBe(before?.content_hash);
      expect(rawMetadata?.raw_json).toContain("updated-model-placeholder");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("advertises every top-level command for agent discovery", async () => {
    const [{ exitCode, stdout }, help] = await Promise.all([
      runCli(["schema"]),
      runCli(["--help"]),
    ]);
    expect(exitCode).toBe(0);
    expect(help.exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(Object.keys(parsed.data.commands).sort()).toEqual(
      parseUsageCommands(help.stdout).sort(),
    );
    expect(parsed.data.commands.backup).toBeTruthy();
    expect(parsed.data.commands.backup.annotations.destructiveHint).toBe(false);
    expect(parsed.data.commands.backup.annotations.idempotentHint).toBe(false);
    expect(parsed.data.commands.version.annotations.readOnlyHint).toBe(true);
    expect(parsed.data.commands.similar).toBeTruthy();
    expect(parsed.data.commands.similar.annotations.readOnlyHint).toBe(true);
    expect(parsed.data.commands.sessions).toBeTruthy();
    expect(parsed.data.commands.sessions.annotations.readOnlyHint).toBe(true);
    expect(parsed.data.commands.ingest).toBeTruthy();
    expect(parsed.data.commands.ingest.annotations.idempotentHint).toBe(true);
    expect(parsed.data.commands.purge).toBeTruthy();
    expect(parsed.data.commands.purge.annotations.destructiveHint).toBe(true);
    expect(parsed.data.commands.prices.annotations.readOnlyHint).toBe(false);
    expect(parsed.data.commands.timeline.annotations.readOnlyHint).toBe(true);
    expect(parsed.data.commands.workflow.annotations.readOnlyHint).toBe(true);
    expect(parsed.data.commands.workflows.annotations.readOnlyHint).toBe(true);
  });

  it(
    "dry-runs and applies purge using the project_path allow filter",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-purge-"));
      const dbPath = join(dir, "sessions.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--keep",
          source: "claude-code",
          projectPath: "/repo/allowed-project/app",
          title: "Keep me",
          startedAt: 1_700_000_000,
          messages: [{ turn: 1, role: "user", text: "keep", toolCalls: [] }],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cc--drop",
          source: "claude-code",
          projectPath: "/repo/unrelated/app",
          title: "Drop me",
          startedAt: 1_700_000_001,
          messages: [{ turn: 1, role: "user", text: "drop", toolCalls: [] }],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cc--null-path",
          source: "claude-code",
          title: "Drop null project path",
          startedAt: 1_700_000_002,
          messages: [
            { turn: 1, role: "user", text: "drop null", toolCalls: [] },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const dryRun = await runCli(
        ["purge", "--project-path-allow", "allowed-project"],
        {
          AGENTMINE_DB: dbPath,
        },
      );
      expect(dryRun.exitCode).toBe(0);
      const dryRunJson = JSON.parse(dryRun.stdout.trim());
      expect(dryRunJson.data).toMatchObject({
        matched_keep: 1,
        purged: 0,
        would_purge: 2,
        dry_run: true,
        db_path: dbPath,
      });

      const applied = await runCli(
        ["purge", "--project-path-allow", "allowed-project", "--yes"],
        {
          AGENTMINE_DB: dbPath,
        },
      );
      expect(applied.exitCode).toBe(0);
      const appliedJson = JSON.parse(applied.stdout.trim());
      expect(appliedJson.data).toMatchObject({
        matched_keep: 1,
        purged: 2,
        would_purge: 2,
        dry_run: false,
        db_path: dbPath,
      });

      const check = openDb({ readonly: true, init: false, path: dbPath });
      try {
        const rows = check
          .prepare<[], { id: string }>("SELECT id FROM sessions ORDER BY id")
          .all();
        expect(rows.map((row) => row.id)).toEqual(["cc--keep"]);
        const messages = check
          .prepare<[], { count: number }>(
            "SELECT count(*) AS count FROM messages",
          )
          .get();
        expect(messages?.count).toBe(1);
      } finally {
        check.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "backs up sessions.db to a tar.gz archive with an integrity-checked SQLite snapshot",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-backup-"));
      const dbPath = join(dir, "sessions.db");
      const archivePath = join(dir, "sessions-backup.tar.gz");
      const restoreDir = join(dir, "restore");
      mkdirSync(restoreDir);

      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--backup-me",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "Backup me",
          startedAt: 1_700_000_000,
          messages: [
            { turn: 1, role: "user", text: "keep this session", toolCalls: [] },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["backup", "--output", archivePath],
        {
          AGENTMINE_DB: dbPath,
        },
      );
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.command).toBe("agentmine backup");
      expect(parsed.data.archive_path).toBe(archivePath);
      expect(parsed.data.db_path).toBe(dbPath);
      expect(parsed.data.integrity_check).toBe("ok");
      expect(parsed.data.included_files).toContain("sessions.db");
      expect(existsSync(archivePath)).toBe(true);

      await execa("tar", ["-xzf", archivePath, "-C", restoreDir]);
      const restored = openDb({
        readonly: true,
        init: false,
        path: join(restoreDir, "sessions.db"),
      });
      try {
        const row = restored
          .prepare<[], { title: string }>(
            "SELECT title FROM sessions WHERE id = 'cc--backup-me'",
          )
          .get();
        expect(row?.title).toBe("Backup me");
      } finally {
        restored.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "refuses to overwrite an existing backup archive unless forced",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-backup-conflict-"));
      const dbPath = join(dir, "sessions.db");
      const archivePath = join(dir, "sessions-backup.tar.gz");
      const existingBytes = "existing backup";
      writeFileSync(archivePath, existingBytes);

      const db = openDb({ path: dbPath });
      db.close();

      const { exitCode, stdout } = await runCli(
        ["backup", "--output", archivePath],
        {
          AGENTMINE_DB: dbPath,
        },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("--force");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "lists database tables and views for schema discovery",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-schema-tables-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      db.close();

      const { exitCode, stdout } = await runCli(["schema", "--tables"], {
        AGENTMINE_DB: dbPath,
      });
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.tables).toContain("messages");
      expect(parsed.data.views).toContain("v_top_files");
      expect(parsed.data.tables).not.toContain("messages_fts_data");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "describes one database table for schema discovery",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-schema-table-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      db.close();

      const { exitCode, stdout } = await runCli(
        ["schema", "--table", "messages"],
        {
          AGENTMINE_DB: dbPath,
        },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.table).toBe("messages");
      expect(
        parsed.data.columns.map((col: { name: string }) => col.name),
      ).toEqual([
        "session_id",
        "turn",
        "role",
        "author",
        "ts",
        "text",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_creation_tokens",
        "reasoning_tokens",
      ]);
      expect(parsed.data.create_sql).toContain("CREATE TABLE messages");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "includes cursor in sync source validation",
    async () => {
      const { exitCode, stdout } = await runCli([
        "sync",
        "--source",
        "nope",
        "--dry-run",
      ]);
      expect(exitCode).toBe(2);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.errors[0].message).toContain("cursor");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "dry-runs Claude history tarball extraction during sync",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-claude-history-"));
      const archiveRoot = join(dir, "archive");
      const projectDir = join(archiveRoot, ".claude", "projects", "-tmp-repo");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "sess-001.jsonl"),
        `${JSON.stringify({
          type: "last-prompt",
          lastPrompt: "hello",
          sessionId: "sess-001",
        })}\n`,
      );
      const archive = join(dir, "claude-history-test.tar.gz");
      await execa("tar", ["-czf", archive, "-C", archiveRoot, ".claude"]);

      const { exitCode, stdout } = await runCli([
        "sync",
        "--source",
        "codex",
        "--dry-run",
        "--claude-history",
        archive,
      ]);
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const history = parsed.data.results.find(
        (r: { source: string }) => r.source === archive,
      );
      expect(history.files).toBe(1);
      expect(history.target).toContain(
        join("agentmine", "sessions", "claude-code"),
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "finds similar sessions and returns reconstruction commands",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-similar-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--auth-router",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "React Router auth redirect fix",
          startedAt: 1_700_000_000,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "fix React Router authentication redirect loop",
              toolCalls: [],
            },
            {
              turn: 2,
              role: "assistant",
              text: "Use a loader redirect and preserve the return URL.",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cc--unrelated",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "SQLite schema migration",
          startedAt: 1_700_000_100,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "update sqlite schema version",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["similar", "React Router auth redirect", "--limit", "3"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.command).toBe("agentmine similar");
      expect(parsed.data.query).toBe("React Router auth redirect");
      expect(parsed.data.rows[0].session_id).toBe("cc--auth-router");
      expect(parsed.data.rows[0].reconstruct_command).toBe(
        "agentmine session cc--auth-router --md",
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "defaults similar to the current project across all sources",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-similar-project-"));
      const dbPath = join(dir, "test.db");
      const projectRoot = join(dir, "repo", "app");
      const otherProject = join(dir, "repo", "other");
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(otherProject, { recursive: true });
      const db = openDb({ path: dbPath });
      try {
        for (const [id, source, projectPath] of [
          ["cc--project-auth", "claude-code", projectRoot],
          ["cur--project-auth", "cursor", join(projectRoot, "packages", "web")],
          ["cc--other-auth", "claude-code", otherProject],
        ] as const) {
          upsertSession(db, {
            id,
            source,
            projectPath,
            title: `${source} auth redirect`,
            startedAt: 1_700_000_000,
            messages: [
              {
                turn: 1,
                role: "user",
                text: "fix React Router authentication redirect loop",
                toolCalls: [],
              },
            ],
            contentHash: randomUUID(),
          });
        }
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["similar", "React Router auth redirect", "--limit", "10"],
        { AGENTMINE_DB: dbPath },
        projectRoot,
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.project_filter).toBe(projectRoot);
      expect(
        parsed.data.rows.map((row: { session_id: string }) => row.session_id),
      ).not.toContain("cc--other-auth");
      expect(
        new Set(parsed.data.rows.map((row: { source: string }) => row.source)),
      ).toEqual(new Set(["claude-code", "cursor"]));
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "excludes the current session from similar results",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-similar-exclude-"));
      const dbPath = join(dir, "test.db");
      const projectRoot = join(dir, "repo", "app");
      mkdirSync(projectRoot, { recursive: true });
      const db = openDb({ path: dbPath });
      try {
        for (const id of ["cc--current-session", "cur--prior-session"]) {
          upsertSession(db, {
            id,
            source: id.startsWith("cur--") ? "cursor" : "claude-code",
            projectPath: projectRoot,
            title: "Auth redirect",
            startedAt: 1_700_000_000,
            messages: [
              {
                turn: 1,
                role: "user",
                text: "fix React Router authentication redirect loop",
                toolCalls: [],
              },
            ],
            contentHash: randomUUID(),
          });
        }
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["similar", "React Router auth redirect", "--limit", "10"],
        {
          AGENTMINE_DB: dbPath,
          AGENTMINE_CURRENT_SESSION_ID: "cc--current-session",
        },
        projectRoot,
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.excluded_sessions).toContain("cc--current-session");
      expect(
        parsed.data.rows.map((row: { session_id: string }) => row.session_id),
      ).toEqual(["cur--prior-session"]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "bounds similar to authored root sessions in a time window",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-similar-bounded-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      const currentDay = Math.floor(Date.parse("2026-07-23T10:00:00Z") / 1000);
      const priorDay = Math.floor(Date.parse("2026-07-22T10:00:00Z") / 1000);
      try {
        upsertSession(db, {
          id: "cx--agentic-docs-root",
          source: "codex",
          projectPath: "/repo/agent-context-kit",
          title: "# AGENTS.md instructions\n\n<INSTRUCTIONS>",
          startedAt: currentDay,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "Move agent-context-kit agentic docs into plugin packages.",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cx--agentic-docs-reviewer",
          source: "codex",
          parentSessionId: "cx--agentic-docs-root",
          agentType: "guardian",
          projectPath: "/repo/agent-context-kit",
          title: "Automatic action review",
          startedAt: currentDay + 1,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "The following is the Codex agent history whose request action you are assessing.\nagent-context-kit agentic docs",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cx--agentic-docs-injected-only",
          source: "codex",
          projectPath: "/repo/other",
          title: "Runtime instructions",
          startedAt: currentDay + 2,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nagent-context-kit agentic docs",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cx--agentic-docs-environment-only",
          source: "codex",
          projectPath: "/repo/other",
          title: "<environment_context>\n  <cwd>/repo/other</cwd>",
          startedAt: currentDay + 3,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "<environment_context>\n  <cwd>/repo/agent-context-kit-agentic-docs</cwd>\n</environment_context>",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cx--agentic-docs-plugin-envelope",
          source: "codex",
          projectPath: "/repo/other",
          title: "<recommended_plugins>\n  <plugin>example</plugin>",
          startedAt: currentDay + 4,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "<recommended_plugins>\n  <plugin>example</plugin>\n</recommended_plugins>\n\n<environment_context>\n  <cwd>/repo/agent-context-kit-agentic-docs</cwd>\n</environment_context>",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
        upsertSession(db, {
          id: "cx--agentic-docs-old",
          source: "codex",
          projectPath: "/repo/agent-context-kit",
          title: "Old agentic docs work",
          startedAt: priorDay,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "Move agent-context-kit agentic docs into plugin packages.",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const boundedArgs = [
        "similar",
        "agent-context-kit agentic docs",
        "--all-projects",
        "--root-only",
        "--since",
        "2026-07-23T00:00:00Z",
        "--until",
        "2026-07-24T00:00:00Z",
        "--limit",
        "10",
      ];
      const bounded = await runCli(boundedArgs, { AGENTMINE_DB: dbPath });
      expect(bounded.exitCode).toBe(0);
      const boundedJson = JSON.parse(bounded.stdout.trim());
      expect(
        boundedJson.data.rows.map(
          (row: { session_id: string }) => row.session_id,
        ),
      ).toEqual(["cx--agentic-docs-root"]);
      expect(boundedJson.data.root_only).toBe(true);
      expect(boundedJson.data.injected_messages_excluded).toBe(true);
      expect(boundedJson.data.since_filter.input).toBe("2026-07-23T00:00:00Z");
      expect(boundedJson.data.until_filter.input).toBe("2026-07-24T00:00:00Z");
      expect(boundedJson.data.rows[0].title).toBeNull();

      const withInjected = await runCli(
        [...boundedArgs, "--include-injected"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(withInjected.exitCode).toBe(0);
      const withInjectedJson = JSON.parse(withInjected.stdout.trim());
      expect(
        new Set(
          withInjectedJson.data.rows.map(
            (row: { session_id: string }) => row.session_id,
          ),
        ),
      ).toEqual(
        new Set([
          "cx--agentic-docs-root",
          "cx--agentic-docs-injected-only",
          "cx--agentic-docs-environment-only",
          "cx--agentic-docs-plugin-envelope",
        ]),
      );
      expect(withInjectedJson.data.injected_messages_excluded).toBe(false);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "rejects impossible calendar dates for similar boundaries",
    async () => {
      const dir = mkdtempSync(
        join(tmpdir(), "agentmine-similar-invalid-date-"),
      );
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      db.close();
      const invalidDate = ["2026", "02", "30"].join("-");

      const result = await runCli(
        ["similar", "agentic docs", "--all-projects", "--since", invalidDate],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("");
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.status).toBe("error");
      expect(parsed.errors[0].name).toBe("INVALID_INPUT");
      expect(parsed.errors[0].message).toContain("--since");
      expect(parsed.errors[0].message).toContain(invalidDate);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "marks broad low-confidence matches without returning distracting rows",
    async () => {
      const dir = mkdtempSync(
        join(tmpdir(), "agentmine-similar-low-confidence-"),
      );
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cur--banana-card",
          source: "cursor",
          projectPath: "/repo/content",
          title: "Banana meetup announcement card",
          startedAt: 1_700_000_000,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "make a square card for a banana meetup announcement",
              toolCalls: [],
            },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["similar", "banana recipe vacation itinerary", "--limit", "5"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.low_confidence).toBe(true);
      expect(parsed.data.row_count).toBe(0);
      expect(parsed.data.rows).toEqual([]);
      expect(parsed.data.warnings).toContain("low_confidence_matches");
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "emits parseable JSON for large markdown session output",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-large-session-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      const longText = "large markdown transcript output ".repeat(120);
      try {
        upsertSession(db, {
          id: "cc--large-markdown",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "Large markdown output",
          startedAt: 1_700_000_000,
          messages: Array.from({ length: 80 }, (_, idx) => ({
            turn: idx + 1,
            role: idx % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text: `${longText}${idx}`,
            toolCalls: [],
          })),
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["session", "cc--large-markdown", "--md"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.command).toBe("agentmine session");
      expect(parsed.data.markdown).toContain("# Session cc--large-markdown");
      expect(parsed.data.markdown).toContain(
        "large markdown transcript output",
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "includes full tool output when --show-context is set",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-show-context-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--show-context",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "Show context",
          startedAt: 1_700_000_000,
          messages: [
            { turn: 1, role: "user", text: "inspect output", toolCalls: [] },
            {
              turn: 2,
              role: "assistant",
              text: "running",
              toolCalls: [
                {
                  name: "Bash",
                  argsHash: "bash",
                  argsPreview: '{"command":"printf long"}',
                  outputPreview: "short preview",
                  outputFull:
                    "full untruncated output that should only appear with show-context",
                  exitCode: 0,
                },
              ],
            },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["session", "cc--show-context", "--show-context"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.data.tool_calls[0].output_text).toContain(
        "full untruncated output",
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "slices session output by turn range and filters tool calls",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-session-slice-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--slice-me",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "Slice me",
          startedAt: 1_700_000_000,
          messages: [
            { turn: 1, role: "user", text: "turn one", toolCalls: [] },
            { turn: 2, role: "assistant", text: "turn two", toolCalls: [] },
            {
              turn: 3,
              role: "assistant",
              text: "turn three",
              toolCalls: [
                {
                  name: "Read",
                  argsHash: "hash-read",
                  argsPreview: '{"file_path":"a.ts"}',
                  outputPreview: "read a.ts",
                  exitCode: 0,
                },
              ],
            },
            { turn: 4, role: "user", text: "turn four", toolCalls: [] },
            { turn: 5, role: "assistant", text: "turn five", toolCalls: [] },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(
        ["session", "cc--slice-me", "--turn-range", "2:4"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(
        parsed.data.messages.map((msg: { turn: number }) => msg.turn),
      ).toEqual([2, 3, 4]);
      expect(
        parsed.data.tool_calls.map((tc: { turn: number }) => tc.turn),
      ).toEqual([3]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "adds previews and reconstruction commands to sessions rows",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-sessions-preview-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        upsertSession(db, {
          id: "cc--list-me",
          source: "claude-code",
          projectPath: "/repo/app",
          title: "List me",
          startedAt: 1_700_000_000,
          endedAt: 1_700_000_060,
          messages: [
            {
              turn: 1,
              role: "user",
              text: "please summarize the session navigation feature",
              toolCalls: [],
            },
            { turn: 2, role: "assistant", text: "done", toolCalls: [] },
          ],
          contentHash: randomUUID(),
        });
      } finally {
        db.close();
      }

      const { exitCode, stdout } = await runCli(["sessions", "--limit", "1"], {
        AGENTMINE_DB: dbPath,
      });
      rmSync(dir, { recursive: true, force: true });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      const row = parsed.data.rows[0];
      expect(row.started_at_iso).toBe("2023-11-14T22:13:20.000Z");
      expect(row.ended_at_iso).toBe("2023-11-14T22:14:20.000Z");
      expect(row.first_user_prompt_preview).toContain(
        "session navigation feature",
      );
      expect(row.reconstruct_command).toBe(
        "agentmine session cc--list-me --md",
      );
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "exposes lineage fields and composes root, parent, agent-type, and child filters",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-session-lineage-"));
      const dbPath = join(dir, "test.db");
      const db = openDb({ path: dbPath });
      try {
        for (const session of [
          {
            id: "cx--root",
            startedAt: 1_700_000_001,
            contentHash: "root",
          },
          {
            id: "cx--worker",
            parentSessionId: "cx--root",
            agentType: "/root/audit",
            startedAt: 1_700_000_002,
            contentHash: "worker",
          },
          {
            id: "cx--guardian",
            parentSessionId: "cx--root",
            agentType: "guardian",
            startedAt: 1_700_000_003,
            contentHash: "guardian",
          },
          {
            id: "cx--other-root",
            startedAt: 1_700_000_004,
            contentHash: "other-root",
          },
        ]) {
          upsertSession(db, {
            source: "codex",
            projectPath: "/repo/app",
            messages: [
              {
                turn: 1,
                role: "user",
                text: `task for ${session.id}`,
                toolCalls: [],
              },
            ],
            ...session,
          });
        }
        runAllExtractors(db);
      } finally {
        db.close();
      }

      const all = await runCli(["sessions", "--limit", "10"], {
        AGENTMINE_DB: dbPath,
      });
      const roots = await runCli(["sessions", "--root-only", "--limit", "10"], {
        AGENTMINE_DB: dbPath,
      });
      const children = await runCli(
        ["sessions", "--parent", "cx--root", "--limit", "10"],
        { AGENTMINE_DB: dbPath },
      );
      const guardians = await runCli(
        ["sessions", "--agent-type", "guardian", "--limit", "10"],
        { AGENTMINE_DB: dbPath },
      );
      const orchestrators = await runCli(
        ["sessions", "--has-subagents", "--limit", "10"],
        { AGENTMINE_DB: dbPath },
      );
      rmSync(dir, { recursive: true, force: true });

      for (const result of [all, roots, children, guardians, orchestrators]) {
        expect(result.exitCode).toBe(0);
      }

      const allRows = JSON.parse(all.stdout.trim()).data.rows;
      expect(allRows).toHaveLength(4);
      expect(
        allRows.find((row: { id: string }) => row.id === "cx--root"),
      ).toMatchObject({
        parent_session_id: null,
        agent_type: null,
        has_subagents: 1,
        subagent_count: 2,
      });
      expect(
        allRows.find((row: { id: string }) => row.id === "cx--worker"),
      ).toMatchObject({
        parent_session_id: "cx--root",
        agent_type: "/root/audit",
        has_subagents: 0,
        subagent_count: 0,
      });

      expect(
        JSON.parse(roots.stdout.trim()).data.rows.map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual(["cx--other-root", "cx--root"]);
      expect(
        JSON.parse(children.stdout.trim()).data.rows.map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual(["cx--guardian", "cx--worker"]);
      expect(
        JSON.parse(guardians.stdout.trim()).data.rows.map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual(["cx--guardian"]);
      expect(
        JSON.parse(orchestrators.stdout.trim()).data.rows.map(
          (row: { id: string }) => row.id,
        ),
      ).toEqual(["cx--root"]);
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "keeps the lineage backfill pending until restored Codex files are reparsed",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentmine-codex-upgrade-"));
      const dataHome = join(dir, "data");
      const rawDir = join(
        dataHome,
        "agentmine",
        "sessions",
        "codex",
        "2026",
        "07",
        "01",
      );
      const qwenRawDir = join(dataHome, "agentmine", "sessions", "qwen");
      const dbPath = join(dir, "sessions.db");
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(qwenRawDir, { recursive: true });

      const fixtureDir = join(__dirname, "fixtures", "codex");
      const rootFixture = join(fixtureDir, "lineage-root.jsonl");
      const childFixture = join(fixtureDir, "lineage-role-worker.jsonl");
      const rootRaw = join(rawDir, "lineage-root.jsonl");
      const childRaw = join(rawDir, "lineage-role-worker.jsonl");
      copyFileSync(rootFixture, rootRaw);
      copyFileSync(childFixture, childRaw);
      const oldMtime = new Date("2020-01-01T00:00:00Z");
      utimesSync(rootRaw, oldMtime, oldMtime);
      utimesSync(childRaw, oldMtime, oldMtime);

      const [root, child] = await Promise.all([
        parseCodexFile(rootFixture),
        parseCodexFile(childFixture),
      ]);
      expect(root).not.toBeNull();
      expect(child).not.toBeNull();
      if (!root || !child) throw new Error("expected Codex lineage fixtures");

      const freshDbPath = join(dir, "fresh.db");
      openDb({ path: freshDbPath }).close();
      const freshRun = await runCli(
        ["normalize", "--source", "codex", "--since", "1d"],
        {
          AGENTMINE_DB: freshDbPath,
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      );
      expect(freshRun.exitCode).toBe(0);
      const freshResult = JSON.parse(freshRun.stdout.trim());
      expect(freshResult.data).toMatchObject({
        files_scanned: 0,
        processed: 0,
      });
      expect(freshResult.data.codex_lineage_backfill).toBeUndefined();

      const legacy = openDb({ path: dbPath });
      upsertSession(legacy, { ...root, agentType: "codex-tui" });
      upsertSession(legacy, {
        ...child,
        parentSessionId: undefined,
        agentType: "codex-tui",
      });
      upsertMeta(legacy, "schema_version", "13");
      legacy.close();

      const dryRun = await runCli(
        ["normalize", "--source", "codex", "--since", "1d", "--dry-run"],
        {
          AGENTMINE_DB: dbPath,
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      );
      expect(dryRun.exitCode).toBe(0);
      expect(JSON.parse(dryRun.stdout.trim()).data).toMatchObject({
        files_scanned: 2,
        processed: 2,
        dry_run: true,
        codex_lineage_backfill: true,
      });
      const untouched = openDb({ readonly: true, init: false, path: dbPath });
      const untouchedChild = untouched
        .prepare<[], { parent_session_id: string | null; agent_type: string }>(
          `SELECT parent_session_id, agent_type
             FROM sessions WHERE id = 'cx--lineage-role-worker-001'`,
        )
        .get();
      expect(untouchedChild).toEqual({
        parent_session_id: null,
        agent_type: "codex-tui",
      });
      expect(getMeta(untouched, "schema_version")).toBe("13");
      expect(
        getMeta(untouched, CODEX_LINEAGE_BACKFILL_META_KEY),
      ).toBeUndefined();
      untouched.close();

      // Simulate an incomplete sync: the migration runs while the old Codex
      // files are temporarily absent, but another source still gives the
      // all-source normalize useful work to do.
      rmSync(rootRaw);
      rmSync(childRaw);
      copyFileSync(
        join(__dirname, "fixtures", "qwen", "tiny.jsonl"),
        join(qwenRawDir, "tiny.jsonl"),
      );
      const incompleteRun = await runCli(["normalize", "--since", "1d"], {
        AGENTMINE_DB: dbPath,
        HOME: dir,
        XDG_DATA_HOME: dataHome,
      });
      expect(incompleteRun.exitCode).toBe(0);
      expect(JSON.parse(incompleteRun.stdout.trim()).data).toMatchObject({
        files_scanned: 1,
        processed_by_source: { qwen: 1 },
        codex_lineage_backfill: true,
      });
      const pending = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(pending, CODEX_LINEAGE_BACKFILL_META_KEY)).toBe("1");
      expect(
        pending
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count
               FROM sessions
              WHERE source = 'codex' AND content_hash IS NULL`,
          )
          .get()?.count,
      ).toBe(2);
      pending.close();

      // Restored archive files retain their old mtimes. The pending marker
      // must make the next --since run include them anyway.
      copyFileSync(rootFixture, rootRaw);
      copyFileSync(childFixture, childRaw);
      utimesSync(rootRaw, oldMtime, oldMtime);
      utimesSync(childRaw, oldMtime, oldMtime);

      const { exitCode, stdout } = await runCli(
        ["normalize", "--source", "codex", "--since", "1d"],
        {
          AGENTMINE_DB: dbPath,
          HOME: dir,
          XDG_DATA_HOME: dataHome,
        },
      );
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout.trim());
      expect(result.data).toMatchObject({
        files_scanned: 2,
        processed: 2,
        codex_lineage_backfill: true,
      });
      expect(result.data.since_epoch).toEqual(expect.any(Number));

      const migrated = openDb({ readonly: true, init: false, path: dbPath });
      const childRow = migrated
        .prepare<
          [string],
          { parent_session_id: string | null; agent_type: string | null }
        >(`SELECT parent_session_id, agent_type FROM sessions WHERE id = ?`)
        .get("cx--lineage-role-worker-001");
      expect(childRow).toEqual({
        parent_session_id: "cx--lineage-root-001",
        agent_type: "researcher",
      });
      expect(getMeta(migrated, CODEX_LINEAGE_BACKFILL_META_KEY)).toBe("0");
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
    },
    CLI_TEST_TIMEOUT,
  );
});
