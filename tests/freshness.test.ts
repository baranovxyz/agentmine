import { randomUUID } from "node:crypto";
import {
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
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { CanonicalSession } from "../src/adapters/types.js";
import { ingestWorkflowRuns } from "../src/adapters/workflowRaw.js";
import { getMeta, openDb, upsertMeta } from "../src/db/client.js";
import {
  LAST_EXTRACT_AT_META_KEY,
  LAST_NORMALIZE_AT_META_KEY,
  readFreshnessSnapshot,
  readWithFreshnessSnapshot,
  recordExtractSuccess,
  recordNormalizeSuccess,
  WORKFLOW_EXTRACT_PENDING_META_KEY,
} from "../src/db/freshness.js";
import { upsertSessionWithPayload } from "../src/db/writer.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);
const TSX_BIN = join(REPO, "node_modules", ".bin", "tsx");
const CLI_ENTRY = join(REPO, "src", "cli.ts");
const CLI_TEST_TIMEOUT = 30_000;

const warningSchema = z.object({
  name: z.string(),
  message: z.string(),
});

const freshnessSchema = z.object({
  last_normalize_at: z.string().nullable(),
  last_extract_at: z.string().nullable(),
  pending_extraction_sessions: z.number(),
  workflow_extraction_pending: z.boolean(),
  oldest_pending_session_started_at: z.string().nullable(),
  newest_pending_session_started_at: z.string().nullable(),
  facts_current: z.boolean(),
});

const statsEnvelopeSchema = z
  .object({
    status: z.string(),
    data: z.object({ freshness: freshnessSchema }).passthrough(),
    warnings: z.array(warningSchema).optional(),
  })
  .passthrough();

const commandEnvelopeSchema = z
  .object({
    status: z.string(),
    data: z.record(z.string(), z.unknown()),
    warnings: z.array(warningSchema).optional(),
  })
  .passthrough();

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-freshness-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeSession(
  id: string,
  startedAt: number,
  withShellCall = false,
): CanonicalSession {
  return {
    id,
    source: "claude-code",
    projectPath: "/tmp/project",
    startedAt,
    contentHash: randomUUID(),
    messages: withShellCall
      ? [
          {
            turn: 1,
            role: "assistant",
            text: "Inspect the directory.",
            toolCalls: [
              {
                name: "Bash",
                args: { command: "pwd" },
                argsHash: randomUUID(),
                argsPreview: '{"command":"pwd"}',
                outputPreview: "/tmp/project",
              },
            ],
          },
        ]
      : [],
  };
}

async function runCli(args: string[], dbPath: string, home?: string) {
  return execa(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: REPO,
    reject: false,
    env: {
      ...process.env,
      NO_COLOR: "1",
      AGENTMINE_DB: dbPath,
      ...(home ? { HOME: home, XDG_DATA_HOME: join(home, "data") } : {}),
    },
  });
}

function warningNames(
  warnings: Array<z.infer<typeof warningSchema>> | undefined,
): string[] {
  return warnings?.map((warning) => warning.name) ?? [];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("freshness snapshot", () => {
  it("reports explicit null timestamps and the pending session range", () => {
    const dbPath = join(makeTempDir(), "sessions.db");
    const db = openDb({ path: dbPath });

    expect(readFreshnessSnapshot(db)).toEqual({
      last_normalize_at: null,
      last_extract_at: null,
      pending_extraction_sessions: 0,
      workflow_extraction_pending: false,
      oldest_pending_session_started_at: null,
      newest_pending_session_started_at: null,
      facts_current: true,
    });

    upsertSessionWithPayload(db, makeSession("older", 1_700_000_000));
    upsertSessionWithPayload(db, makeSession("newer", 1_700_000_100));
    recordNormalizeSuccess(db, new Date("2026-08-11T01:02:03.000Z"));
    recordExtractSuccess(db, new Date("2026-08-11T02:03:04.000Z"));

    expect(readFreshnessSnapshot(db)).toEqual({
      last_normalize_at: "2026-08-11T01:02:03.000Z",
      last_extract_at: "2026-08-11T02:03:04.000Z",
      pending_extraction_sessions: 2,
      workflow_extraction_pending: false,
      oldest_pending_session_started_at: "2023-11-14T22:13:20.000Z",
      newest_pending_session_started_at: "2023-11-14T22:15:00.000Z",
      facts_current: false,
    });
    db.close();
  });

  it("counts dirty rows even when their session timestamp is unavailable", () => {
    const dbPath = join(makeTempDir(), "sessions.db");
    const db = openDb({ path: dbPath });
    db.pragma("foreign_keys = OFF");
    db.prepare(`INSERT INTO dirty_sessions (session_id) VALUES (?)`).run(
      "orphaned-session",
    );

    expect(readFreshnessSnapshot(db)).toMatchObject({
      pending_extraction_sessions: 1,
      oldest_pending_session_started_at: null,
      newest_pending_session_started_at: null,
      facts_current: false,
    });
    db.close();
  });

  it("keeps fact reads and pending signals in one SQLite snapshot", () => {
    const dbPath = join(makeTempDir(), "sessions.db");
    const writer = openDb({ path: dbPath });
    upsertSessionWithPayload(
      writer,
      makeSession("snapshot-pending", 1_700_000_000),
    );
    const reader = openDb({ readonly: true, init: false, path: dbPath });

    const { value: pendingAtRead, freshness } = readWithFreshnessSnapshot(
      reader,
      () => {
        const pending = reader
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM dirty_sessions`,
          )
          .get()?.count;
        writer.prepare(`DELETE FROM dirty_sessions`).run();
        return pending;
      },
    );

    expect(pendingAtRead).toBe(1);
    expect(freshness).toMatchObject({
      pending_extraction_sessions: 1,
      facts_current: false,
    });
    expect(readFreshnessSnapshot(writer)).toMatchObject({
      pending_extraction_sessions: 0,
      facts_current: true,
    });
    reader.close();
    writer.close();
  });

  it("keeps workflow-only changes pending until targeted extraction", async () => {
    const dir = makeTempDir();
    const dbPath = join(dir, "sessions.db");
    const rawRoot = join(dir, "raw-claude-code");
    const workflowDir = join(rawRoot, "project", "session", "workflows");
    mkdirSync(workflowDir, { recursive: true });
    writeFileSync(
      join(workflowDir, "wf_only.json"),
      JSON.stringify({
        runId: "wf_only",
        workflowName: "workflow-only-change",
        status: "completed",
        agentCount: 0,
        totalTokens: 0,
        totalToolCalls: 0,
        durationMs: 1_000,
        startTime: 1_784_050_973_990,
        phases: [],
        workflowProgress: [],
      }),
    );

    const db = openDb({ path: dbPath });
    upsertMeta(db, "extract_incremental_ready", "1");
    expect(await ingestWorkflowRuns(db, rawRoot)).toEqual({
      runs: 1,
      skipped: 0,
    });
    expect(getMeta(db, WORKFLOW_EXTRACT_PENDING_META_KEY)).toBe("1");
    expect(readFreshnessSnapshot(db)).toMatchObject({
      pending_extraction_sessions: 0,
      workflow_extraction_pending: true,
      facts_current: false,
    });
    db.prepare(`DELETE FROM meta WHERE key = ?`).run(
      WORKFLOW_EXTRACT_PENDING_META_KEY,
    );
    expect(readFreshnessSnapshot(db).workflow_extraction_pending).toBe(true);
    db.close();

    const extracted = await runCli(["extract"], dbPath);
    expect(extracted.exitCode, extracted.stdout).toBe(0);
    const envelope = commandEnvelopeSchema.parse(
      JSON.parse(extracted.stdout.trim()),
    );
    expect(envelope.data).toMatchObject({
      skipped: false,
      sessions_scoped: 0,
      workflow_runs: 1,
    });

    const checked = openDb({ readonly: true, init: false, path: dbPath });
    expect(readFreshnessSnapshot(checked)).toMatchObject({
      pending_extraction_sessions: 0,
      workflow_extraction_pending: false,
      facts_current: true,
    });
    expect(
      checked
        .prepare<[], { workflow_name: string }>(
          `SELECT workflow_name FROM workflow_runs WHERE run_id = 'wf_only'`,
        )
        .get(),
    ).toEqual({ workflow_name: "workflow-only-change" });
    checked.close();
  });
});

describe("freshness command warnings", () => {
  it(
    "warns on stale fact reads and clears the warning after extract",
    async () => {
      const dbPath = join(makeTempDir(), "sessions.db");
      const db = openDb({ path: dbPath });
      upsertSessionWithPayload(db, makeSession("pending", 1_700_000_000, true));
      recordNormalizeSuccess(db, new Date("2026-08-11T01:02:03.000Z"));
      db.prepare(
        `INSERT INTO workflow_runs (run_id, workflow_name, status, started_at)
         VALUES (?, ?, ?, ?)`,
      ).run("wf_pending", "pending-workflow", "completed", 1_700_000_000);
      db.close();

      const [
        stats,
        query,
        top,
        tokens,
        dynamicSequences,
        workflows,
        workflow,
        sessions,
        session,
        markdownSession,
      ] = await Promise.all([
        runCli(["stats"], dbPath),
        runCli(
          ["query", "SELECT COUNT(*) AS count FROM shell_commands"],
          dbPath,
        ),
        runCli(["top", "commands"], dbPath),
        runCli(["top", "tokens"], dbPath),
        runCli(["top", "sequences", "--project", "/tmp/project"], dbPath),
        runCli(["workflows"], dbPath),
        runCli(["workflow", "wf_pending"], dbPath),
        runCli(["sessions"], dbPath),
        runCli(["session", "pending"], dbPath),
        runCli(["session", "pending", "--md"], dbPath),
      ]);

      expect(stats.exitCode).toBe(0);
      expect(query.exitCode).toBe(0);
      expect(top.exitCode).toBe(0);
      expect(tokens.exitCode).toBe(0);
      expect(dynamicSequences.exitCode).toBe(0);
      expect(workflows.exitCode).toBe(0);
      expect(workflow.exitCode).toBe(0);
      expect(sessions.exitCode).toBe(0);
      expect(session.exitCode).toBe(0);
      expect(markdownSession.exitCode).toBe(0);

      const staleStats = statsEnvelopeSchema.parse(
        JSON.parse(stats.stdout.trim()),
      );
      expect(staleStats.data.freshness).toMatchObject({
        pending_extraction_sessions: 1,
        facts_current: false,
      });
      expect(warningNames(staleStats.warnings)).toContain("EXTRACTION_PENDING");
      expect(staleStats.warnings?.[0]?.message).toContain("agentmine extract");

      for (const result of [
        query,
        top,
        workflows,
        workflow,
        sessions,
        session,
      ]) {
        const envelope = commandEnvelopeSchema.parse(
          JSON.parse(result.stdout.trim()),
        );
        expect(warningNames(envelope.warnings)).toContain("EXTRACTION_PENDING");
      }
      expect(
        warningNames(
          commandEnvelopeSchema.parse(JSON.parse(markdownSession.stdout.trim()))
            .warnings,
        ),
      ).not.toContain("EXTRACTION_PENDING");
      const tokenEnvelope = commandEnvelopeSchema.parse(
        JSON.parse(tokens.stdout.trim()),
      );
      expect(warningNames(tokenEnvelope.warnings)).not.toContain(
        "EXTRACTION_PENDING",
      );
      const dynamicSequenceEnvelope = commandEnvelopeSchema.parse(
        JSON.parse(dynamicSequences.stdout.trim()),
      );
      expect(warningNames(dynamicSequenceEnvelope.warnings)).not.toContain(
        "EXTRACTION_PENDING",
      );

      const extracted = await runCli(["extract"], dbPath);
      expect(extracted.exitCode).toBe(0);

      const checked = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(checked, LAST_EXTRACT_AT_META_KEY)).toMatch(
        /^\d{4}-\d{2}-\d{2}T/u,
      );
      checked.close();

      const [
        freshStatsResult,
        freshQueryResult,
        freshTopResult,
        freshWorkflows,
      ] = await Promise.all([
        runCli(["stats"], dbPath),
        runCli(
          ["query", "SELECT COUNT(*) AS count FROM shell_commands"],
          dbPath,
        ),
        runCli(["top", "commands"], dbPath),
        runCli(["workflows"], dbPath),
      ]);
      const freshStats = statsEnvelopeSchema.parse(
        JSON.parse(freshStatsResult.stdout.trim()),
      );
      expect(freshStats.data.freshness).toMatchObject({
        pending_extraction_sessions: 0,
        facts_current: true,
      });
      expect(warningNames(freshStats.warnings)).not.toContain(
        "EXTRACTION_PENDING",
      );
      for (const result of [freshQueryResult, freshTopResult, freshWorkflows]) {
        const envelope = commandEnvelopeSchema.parse(
          JSON.parse(result.stdout.trim()),
        );
        expect(warningNames(envelope.warnings)).not.toContain(
          "EXTRACTION_PENDING",
        );
      }

      const oldExtractTimestamp = "2000-01-01T00:00:00.000Z";
      const beforeNoOp = openDb({ path: dbPath });
      upsertMeta(beforeNoOp, LAST_EXTRACT_AT_META_KEY, oldExtractTimestamp);
      beforeNoOp.close();

      const noOpExtract = await runCli(["extract"], dbPath);
      expect(noOpExtract.exitCode).toBe(0);
      expect(
        commandEnvelopeSchema.parse(JSON.parse(noOpExtract.stdout.trim())).data
          .skipped,
      ).toBe(true);
      const afterNoOp = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(afterNoOp, LAST_EXTRACT_AT_META_KEY)).not.toBe(
        oldExtractTimestamp,
      );
      afterNoOp.close();

      const beforeForce = openDb({ path: dbPath });
      upsertMeta(beforeForce, LAST_EXTRACT_AT_META_KEY, oldExtractTimestamp);
      beforeForce.close();
      const forcedExtract = await runCli(["extract", "--force"], dbPath);
      expect(forcedExtract.exitCode).toBe(0);
      const afterForce = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(afterForce, LAST_EXTRACT_AT_META_KEY)).not.toBe(
        oldExtractTimestamp,
      );
      afterForce.close();

      const beforeFailure = openDb({ path: dbPath });
      upsertSessionWithPayload(
        beforeFailure,
        makeSession("pending-failure", 1_700_000_100, true),
      );
      upsertMeta(beforeFailure, LAST_EXTRACT_AT_META_KEY, oldExtractTimestamp);
      beforeFailure.execBatch(`
        CREATE TRIGGER fail_shell_insert
        BEFORE INSERT ON shell_commands
        BEGIN
          SELECT RAISE(ABORT, 'synthetic extract failure');
        END;
      `);
      beforeFailure.close();

      const failedExtract = await runCli(["extract"], dbPath);
      expect(failedExtract.exitCode).not.toBe(0);
      const afterFailure = openDb({
        readonly: true,
        init: false,
        path: dbPath,
      });
      expect(getMeta(afterFailure, LAST_EXTRACT_AT_META_KEY)).toBe(
        oldExtractTimestamp,
      );
      expect(
        afterFailure
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM dirty_sessions`,
          )
          .get()?.count,
      ).toBe(1);
      afterFailure.close();
    },
    CLI_TEST_TIMEOUT,
  );
});

describe("normalize freshness lifecycle", () => {
  it(
    "ingests workflow-only changes when --since finds no transcripts",
    async () => {
      const home = makeTempDir();
      const dbPath = join(home, "sessions.db");
      const workflowDir = join(
        home,
        "data",
        "agentmine",
        "sessions",
        "claude-code",
        "project",
        "session",
        "workflows",
      );
      mkdirSync(workflowDir, { recursive: true });
      writeFileSync(
        join(workflowDir, "wf_since.json"),
        JSON.stringify({
          runId: "wf_since",
          workflowName: "workflow-since-change",
          status: "completed",
          agentCount: 0,
          totalTokens: 0,
          totalToolCalls: 0,
          durationMs: 1_000,
          startTime: 1_784_050_973_990,
          phases: [],
          workflowProgress: [],
        }),
      );

      const normalized = await runCli(
        ["normalize", "--source", "claude-code", "--since", "1s"],
        dbPath,
        home,
      );
      expect(normalized.exitCode, normalized.stdout).toBe(0);
      expect(
        commandEnvelopeSchema.parse(JSON.parse(normalized.stdout.trim())).data,
      ).toMatchObject({
        files_scanned: 0,
        processed: 0,
        workflow_runs: 1,
      });

      const checked = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(checked, WORKFLOW_EXTRACT_PENDING_META_KEY)).toBe("1");
      expect(readFreshnessSnapshot(checked)).toMatchObject({
        pending_extraction_sessions: 0,
        workflow_extraction_pending: true,
        facts_current: false,
      });
      expect(
        checked
          .prepare<[], { count: number }>(
            `SELECT COUNT(*) AS count FROM raw_workflow_runs
             WHERE run_id = 'wf_since'`,
          )
          .get()?.count,
      ).toBe(1);
      checked.close();
    },
    CLI_TEST_TIMEOUT,
  );

  it(
    "advances only after a successful non-dry-run normalize",
    async () => {
      const home = makeTempDir();
      const dbPath = join(home, "sessions.db");
      const inputRoot = join(home, "extension-input");
      const inputFile = join(inputRoot, "session.jsonl");
      const extensionDir = join(home, ".config", "agentmine");
      mkdirSync(inputRoot, { recursive: true });
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(inputFile, "fixture\n");
      writeFileSync(
        join(extensionDir, "extensions.js"),
        [
          `const rootPath = ${JSON.stringify(inputRoot)};`,
          `const inputFile = ${JSON.stringify(inputFile)};`,
          "export default { adapters: [",
          "  {",
          '    name: "success-source",',
          "    rootPath,",
          "    listFiles: async () => [inputFile],",
          "    parse: async () => ({",
          '      id: "extension--success",',
          '      source: "success-source",',
          "      startedAt: 1700000000,",
          "      messages: [],",
          '      contentHash: "freshness-success",',
          "    }),",
          "  },",
          "  {",
          '    name: "failing-source",',
          "    rootPath,",
          "    listFiles: async () => [inputFile],",
          '    parse: async () => { throw new Error("synthetic parse failure"); },',
          "  },",
          "] };",
          "",
        ].join("\n"),
      );

      const successful = await runCli(
        ["normalize", "--source", "success-source"],
        dbPath,
        home,
      );
      expect(successful.exitCode).toBe(0);

      const afterSuccess = openDb({
        readonly: true,
        init: false,
        path: dbPath,
      });
      const successfulTimestamp = getMeta(
        afterSuccess,
        LAST_NORMALIZE_AT_META_KEY,
      );
      afterSuccess.close();
      expect(successfulTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

      const dryRun = await runCli(
        ["normalize", "--source", "success-source", "--force", "--dry-run"],
        dbPath,
        home,
      );
      expect(dryRun.exitCode).toBe(0);

      const partial = await runCli(
        ["normalize", "--source", "failing-source", "--force"],
        dbPath,
        home,
      );
      expect(partial.exitCode).toBe(1);

      const afterUnsuccessfulRuns = openDb({
        readonly: true,
        init: false,
        path: dbPath,
      });
      expect(getMeta(afterUnsuccessfulRuns, LAST_NORMALIZE_AT_META_KEY)).toBe(
        successfulTimestamp,
      );
      afterUnsuccessfulRuns.close();

      const oldNormalizeTimestamp = "2000-01-01T00:00:00.000Z";
      const beforeNoOp = openDb({ path: dbPath });
      upsertMeta(beforeNoOp, LAST_NORMALIZE_AT_META_KEY, oldNormalizeTimestamp);
      beforeNoOp.close();
      const oldMtime = new Date("2000-01-01T00:00:00.000Z");
      utimesSync(inputFile, oldMtime, oldMtime);

      const noOp = await runCli(
        ["normalize", "--source", "success-source", "--since", "1s"],
        dbPath,
        home,
      );
      expect(noOp.exitCode).toBe(0);
      const noOpEnvelope = commandEnvelopeSchema.parse(
        JSON.parse(noOp.stdout.trim()),
      );
      expect(noOpEnvelope.data.files_scanned).toBe(0);
      const afterNoOp = openDb({ readonly: true, init: false, path: dbPath });
      expect(getMeta(afterNoOp, LAST_NORMALIZE_AT_META_KEY)).not.toBe(
        oldNormalizeTimestamp,
      );
      afterNoOp.close();
    },
    CLI_TEST_TIMEOUT,
  );
});
