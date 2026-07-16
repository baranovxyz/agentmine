import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

type Data = Record<string, unknown>;
type Outcome = CommandOutcome<Data>;

const RESULT_PREVIEW_MAX = 2000;

/**
 * `agentmine workflow <run_id>` -- inspect one workflow run: its rollups, its
 * ordered phases, and its per-agent rows (phase, state, tokens, tool calls,
 * result preview). The full per-agent return value is in
 * `workflow_agents.result_full`; here it is reported as a bounded excerpt plus a
 * byte count to keep the envelope small.
 */
export const workflowCommand = defineCommand({
  meta: {
    name: "workflow",
    description: "Inspect one workflow run: rollups, phases, per-agent rows",
  },
  args: {
    id: {
      type: "positional",
      required: true,
      description: "Workflow run id (e.g. wf_<id>)",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine workflow",
      handler: async (): Promise<Outcome> => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const runId = String(args.id ?? "");
        if (!runId) throw Errors.invalidInput("workflow run id required");

        const db = openDb({ readonly: true });
        try {
          const run = db
            .prepare<[string], Record<string, unknown>>(
              `SELECT w.*, s.project_path, s.git_branch
                 FROM workflow_runs w
                 LEFT JOIN sessions s ON s.id = w.orchestrating_session_id
                WHERE w.run_id = ?`,
            )
            .get(runId);
          if (!run) throw Errors.notFound(`Workflow run ${runId} not found`);

          const phases = db
            .prepare<[string], Record<string, unknown>>(
              `SELECT phase_index, title, detail
                 FROM workflow_run_phases WHERE run_id = ? ORDER BY phase_index`,
            )
            .all(runId);

          const agents = db
            .prepare<[string], Record<string, unknown>>(
              `SELECT run_id, agent_id, agent_session_id, phase_index, phase_title,
                      label, model, state, attempt, tokens, tool_calls,
                      duration_ms, started_at, result_preview, result_full
                 FROM workflow_agents WHERE run_id = ?
                ORDER BY phase_index, started_at, agent_id`,
            )
            .all(runId)
            .map(enrichAgentRow);

          return {
            data: {
              run: { ...run, started_at_iso: epochToIso(run["started_at"]) },
              phases,
              agents,
            },
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

function enrichAgentRow(row: Record<string, unknown>): Record<string, unknown> {
  const full =
    typeof row["result_full"] === "string" ? row["result_full"] : null;
  return {
    ...row,
    result_full: full ? full.slice(0, RESULT_PREVIEW_MAX) : null,
    result_full_bytes: full ? Buffer.byteLength(full, "utf8") : 0,
    started_at_iso: epochToIso(row["started_at"]),
    session_command:
      typeof row["agent_session_id"] === "string"
        ? `agentmine session ${row["agent_session_id"]} --md`
        : null,
  };
}

function epochToIso(value: unknown): string | null {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : null;
}
