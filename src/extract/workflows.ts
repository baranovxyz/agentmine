/**
 * Derive workflow-run fact tables from the raw workflow tables.
 *
 * Reads only from `raw_workflow_runs` / `raw_workflow_journal` (DB-only, like
 * every extractor) and decodes them with the shared agent-canonical Claude Code
 * workflow decoders. Produces:
 *
 *   - `workflow_runs`        one row per run (rollups + orchestrating session)
 *   - `workflow_run_phases`  the run's ordered phases
 *   - `workflow_agents`      per-agent linkage (phase, state, tokens, result)
 *
 * A run's orchestrating session and each agent's session are linked by id only
 * when that session is present in the corpus; otherwise the link is left NULL
 * and backfills on a later extract once the session is ingested. The full,
 * untruncated per-agent return value comes from the journal `result` events.
 *
 * Idempotent: full DELETE + re-derive inside one transaction.
 */

import { IssueCollector } from "agent-canonical/parsers";
import {
  decodeWorkflowJournal,
  decodeWorkflowManifest,
} from "agent-canonical/parsers/claude-code";
import type { DatabaseType } from "../db/client.js";

interface RawRunRow {
  run_id: string;
  orchestrating_external_id: string | null;
  raw_json: string;
}

interface JournalRow {
  raw_json: string;
}

export function extractWorkflowRuns(db: DatabaseType): number {
  const runRows = db
    .prepare<[], RawRunRow>(
      `SELECT run_id, orchestrating_external_id, raw_json FROM raw_workflow_runs`,
    )
    .all();

  const sessionIds = new Set<string>(
    db
      .prepare<[], { id: string }>(`SELECT id FROM sessions`)
      .all()
      .map((r) => r.id),
  );
  const resolve = (externalId: string | null | undefined): string | null => {
    if (!externalId) return null;
    const id = `cc--${externalId}`;
    return sessionIds.has(id) ? id : null;
  };

  const journalStmt = db.prepare<[string], JournalRow>(
    `SELECT raw_json FROM raw_workflow_journal
      WHERE run_id = ? AND event_type = 'result' ORDER BY seq`,
  );
  const insertRun = db.prepare(
    `INSERT INTO workflow_runs
       (run_id, orchestrating_session_id, workflow_name, status, agent_count,
        total_tokens, total_tool_calls, duration_ms, started_at, summary, script_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPhase = db.prepare(
    `INSERT OR REPLACE INTO workflow_run_phases (run_id, phase_index, title, detail)
     VALUES (?, ?, ?, ?)`,
  );
  const insertAgent = db.prepare(
    `INSERT OR REPLACE INTO workflow_agents
       (run_id, agent_id, agent_session_id, phase_index, phase_title, label,
        model, state, attempt, tokens, tool_calls, duration_ms, started_at,
        result_preview, result_full)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  let runs = 0;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM workflow_runs`).run();
    db.prepare(`DELETE FROM workflow_agents`).run();
    db.prepare(`DELETE FROM workflow_run_phases`).run();

    for (const row of runRows) {
      let manifestRaw: unknown;
      try {
        manifestRaw = JSON.parse(row.raw_json);
      } catch {
        continue;
      }
      const decoded = decodeWorkflowManifest(manifestRaw, new IssueCollector());
      if (!decoded.success) continue;
      const m = decoded.data;

      insertRun.run(
        row.run_id,
        resolve(row.orchestrating_external_id),
        m.workflowName ?? null,
        m.status ?? null,
        m.agentCount ?? null,
        m.totalTokens ?? null,
        m.totalToolCalls ?? null,
        m.durationMs ?? null,
        msToSec(m.startedAtMs),
        m.summary ?? null,
        m.scriptPath ?? null,
      );

      for (const p of m.phases) {
        insertPhase.run(row.run_id, p.index, p.title ?? null, p.detail ?? null);
      }

      // Full per-agent return values live in the journal `result` events.
      const resultByAgent = new Map<string, string>();
      const journalRows = journalStmt.all(row.run_id);
      if (journalRows.length > 0) {
        const events = decodeWorkflowJournal(
          journalRows.map((j) => j.raw_json),
          new IssueCollector(),
        );
        if (events.success) {
          for (const ev of events.data) {
            if (ev.type === "result" && ev.agentId && ev.result !== undefined) {
              resultByAgent.set(ev.agentId, JSON.stringify(ev.result));
            }
          }
        }
      }

      for (const a of m.agents) {
        insertAgent.run(
          row.run_id,
          a.agentId,
          resolve(a.agentId),
          a.phaseIndex ?? null,
          a.phaseTitle ?? null,
          a.label ?? null,
          a.model ?? null,
          a.state ?? null,
          a.attempt ?? null,
          a.tokens ?? null,
          a.toolCalls ?? null,
          a.durationMs ?? null,
          msToSec(a.startedAtMs),
          a.resultPreview ?? null,
          resultByAgent.get(a.agentId) ?? null,
        );
      }
      runs += 1;
    }
  });
  tx();
  return runs;
}

function msToSec(ms: number | undefined): number | null {
  return ms === undefined ? null : Math.floor(ms / 1000);
}
