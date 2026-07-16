import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanonicalSession } from "../src/adapters/types.js";
import { type DatabaseType, openDb } from "../src/db/client.js";
import {
  upsertSession,
  upsertWorkflowRunRaw,
  type WorkflowJournalLineRaw,
} from "../src/db/writer.js";
import { runAllExtractors } from "../src/extract/index.js";
import { extractWorkflowRuns } from "../src/extract/workflows.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentmine-wf-test-"));
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

interface ManifestOverrides {
  runId?: string;
  workflowName?: string;
  status?: string;
}

function makeManifest(o: ManifestOverrides = {}): Record<string, unknown> {
  return {
    runId: o.runId ?? "wf_test1",
    workflowName: o.workflowName ?? "demo-workflow",
    status: o.status ?? "completed",
    agentCount: 2,
    totalTokens: 1000,
    totalToolCalls: 5,
    durationMs: 60_000,
    startTime: 1_784_050_973_990,
    summary: "did the thing",
    scriptPath: "/x/demo.js",
    phases: [
      { title: "Sweep", detail: "parallel sweeps" },
      { title: "Synthesize", detail: "rank" },
    ],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Sweep" },
      { type: "workflow_phase", index: 2, title: "Synthesize" },
      {
        type: "workflow_agent",
        index: 1,
        label: "sweep:a",
        phaseIndex: 1,
        phaseTitle: "Sweep",
        agentId: "aAAA",
        model: "claude-fable-5",
        state: "done",
        attempt: 1,
        tokens: 400,
        toolCalls: 3,
        durationMs: 30_000,
        startedAt: 1_784_050_973_990,
        resultPreview: '{"x":1}',
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "synth:b",
        phaseIndex: 2,
        phaseTitle: "Synthesize",
        agentId: "aBBB",
        model: "claude-opus-4-8",
        state: "done",
        attempt: 1,
        tokens: 600,
        toolCalls: 2,
        durationMs: 30_000,
        startedAt: 1_784_050_980_000,
        resultPreview: '{"y":2}',
      },
    ],
  };
}

function journalRowsFor(
  entries: Array<{ type: string; agentId: string; result?: unknown }>,
): WorkflowJournalLineRaw[] {
  return entries.map((e, seq) => ({
    seq,
    agentId: e.agentId,
    eventType: e.type,
    key: `v2:${e.agentId}`,
    rawJson: JSON.stringify({
      type: e.type,
      agentId: e.agentId,
      key: `v2:${e.agentId}`,
      ...(e.result !== undefined ? { result: e.result } : {}),
    }),
  }));
}

/** Store one workflow run's raw manifest + journal, as normalize would. */
function seedRun(
  db: DatabaseType,
  opts: {
    runId?: string;
    orchestratingExternalId?: string | null;
    manifest?: Record<string, unknown>;
    journal?: WorkflowJournalLineRaw[];
  } = {},
): void {
  const manifest = opts.manifest ?? makeManifest({ runId: opts.runId });
  upsertWorkflowRunRaw(db, {
    runId: opts.runId ?? "wf_test1",
    source: "claude-code",
    orchestratingExternalId:
      opts.orchestratingExternalId === undefined
        ? "sess-orch"
        : opts.orchestratingExternalId,
    rawPath: "/x/workflows/wf_test1.json",
    contentHash: randomUUID(),
    manifestJson: JSON.stringify(manifest),
    journalLines:
      opts.journal ??
      journalRowsFor([
        { type: "started", agentId: "aAAA" },
        { type: "result", agentId: "aAAA", result: { x: 1, note: "full-a" } },
        { type: "started", agentId: "aBBB" },
        { type: "result", agentId: "aBBB", result: { y: 2, note: "full-b" } },
      ]),
  });
}

describe("workflow-run ingest", () => {
  let db: DatabaseType;
  beforeEach(() => {
    db = openDb({ path: tmpDbPath() });
  });

  it("derives run rollups, ordered phases, and per-agent linkage", () => {
    seedRun(db);
    const runs = extractWorkflowRuns(db);
    expect(runs).toBe(1);

    const run = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT * FROM workflow_runs WHERE run_id = ?`,
      )
      .get("wf_test1");
    expect(run?.workflow_name).toBe("demo-workflow");
    expect(run?.agent_count).toBe(2);
    expect(run?.total_tokens).toBe(1000);
    // startTime ms → seconds.
    expect(run?.started_at).toBe(1_784_050_973);

    const phases = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT phase_index, title FROM workflow_run_phases WHERE run_id = ? ORDER BY phase_index`,
      )
      .all("wf_test1");
    expect(phases.map((p) => p.title)).toEqual(["Sweep", "Synthesize"]);

    const agents = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT agent_id, phase_index, phase_title, tokens FROM workflow_agents WHERE run_id = ? ORDER BY phase_index`,
      )
      .all("wf_test1");
    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      agent_id: "aAAA",
      phase_index: 1,
      phase_title: "Sweep",
      tokens: 400,
    });
  });

  it("captures the full result from the journal, preview from the manifest", () => {
    seedRun(db);
    extractWorkflowRuns(db);
    const a = db
      .prepare<[string, string], Record<string, unknown>>(
        `SELECT result_preview, result_full FROM workflow_agents WHERE run_id = ? AND agent_id = ?`,
      )
      .get("wf_test1", "aAAA");
    expect(a?.result_preview).toBe('{"x":1}');
    expect(JSON.parse(String(a?.result_full))).toMatchObject({
      x: 1,
      note: "full-a",
    });
  });

  it("degrades gracefully when a run has no journal", () => {
    seedRun(db, { journal: [] });
    extractWorkflowRuns(db);
    const a = db
      .prepare<[string, string], Record<string, unknown>>(
        `SELECT result_preview, result_full FROM workflow_agents WHERE run_id = ? AND agent_id = ?`,
      )
      .get("wf_test1", "aAAA");
    expect(a?.result_preview).toBe('{"x":1}');
    expect(a?.result_full).toBeNull();
  });

  it("leaves session links NULL when sessions are absent, then backfills them", () => {
    seedRun(db);
    extractWorkflowRuns(db);
    let a = db
      .prepare<[string, string], Record<string, unknown>>(
        `SELECT agent_session_id FROM workflow_agents WHERE run_id = ? AND agent_id = ?`,
      )
      .get("wf_test1", "aAAA");
    expect(a?.agent_session_id).toBeNull();

    // Ingest the orchestrating + agent sessions, then re-derive.
    upsertSession(db, makeSession({ id: "cc--sess-orch" }));
    upsertSession(db, makeSession({ id: "cc--aAAA" }));
    extractWorkflowRuns(db);

    a = db
      .prepare<[string, string], Record<string, unknown>>(
        `SELECT agent_session_id FROM workflow_agents WHERE run_id = ? AND agent_id = ?`,
      )
      .get("wf_test1", "aAAA");
    expect(a?.agent_session_id).toBe("cc--aAAA");
    const run = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT orchestrating_session_id FROM workflow_runs WHERE run_id = ?`,
      )
      .get("wf_test1");
    expect(run?.orchestrating_session_id).toBe("cc--sess-orch");
  });

  it("is idempotent across re-derivation", () => {
    seedRun(db);
    expect(extractWorkflowRuns(db)).toBe(1);
    expect(extractWorkflowRuns(db)).toBe(1);
    const counts = db
      .prepare<[], { runs: number; agents: number; phases: number }>(
        `SELECT (SELECT COUNT(*) FROM workflow_runs) AS runs,
                (SELECT COUNT(*) FROM workflow_agents) AS agents,
                (SELECT COUNT(*) FROM workflow_run_phases) AS phases`,
      )
      .get();
    expect(counts).toEqual({ runs: 1, agents: 2, phases: 2 });
  });

  it("counts file-separated children in the subagent rollup", () => {
    const parent = makeSession({ id: "cc--parent" });
    const child = makeSession({
      id: "cc--child",
      parentSessionId: "cc--parent",
    });
    upsertSession(db, parent);
    upsertSession(db, child);
    runAllExtractors(db);
    const row = db
      .prepare<[string], { has_subagents: number; subagent_count: number }>(
        `SELECT has_subagents, subagent_count FROM sessions WHERE id = ?`,
      )
      .get("cc--parent");
    expect(row?.has_subagents).toBe(1);
    expect(row?.subagent_count).toBe(1);
  });
});
