import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { parseSince } from "./_filters.js";

type Data = Record<string, unknown>;
type Outcome = CommandOutcome<Data>;

const SORTS: Record<string, string> = {
  started: "w.started_at DESC",
  tokens: "w.total_tokens DESC",
  duration: "w.duration_ms DESC",
  agents: "w.agent_count DESC",
  name: "w.workflow_name ASC",
};

/**
 * `agentmine workflows` -- list + rank Claude Code workflow runs.
 *
 * Filters: --project (orchestrating session's project_path prefix), --status,
 * --since (on/after started_at). --sort ranks by started|tokens|duration|agents|name.
 */
export const workflowsCommand = defineCommand({
  meta: {
    name: "workflows",
    description: "List Claude Code workflow runs with filters + ranking",
  },
  args: {
    project: {
      type: "string",
      description: "Filter by orchestrating session project_path (prefix)",
    },
    status: { type: "string", description: "Filter by run status" },
    since: {
      type: "string",
      description:
        "ISO date, YYYY-MM-DD, or relative offset (e.g. 7d, 2w); runs on/after",
    },
    sort: {
      type: "string",
      default: "started",
      description: `Sort by one of: ${Object.keys(SORTS).join(", ")}`,
    },
    limit: { type: "string", default: "50" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine workflows",
      handler: async (): Promise<Outcome> => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const sortKey = String(args.sort ?? "started");
        const orderBy = SORTS[sortKey];
        if (!orderBy) {
          throw Errors.invalidInput(
            `--sort must be one of ${Object.keys(SORTS).join(", ")} (got '${sortKey}')`,
          );
        }
        const db = openDb({ readonly: true });
        try {
          const limit = parseLimit(args.limit, 50);
          const clauses: string[] = [];
          const params: unknown[] = [];

          if (args.project) {
            clauses.push("s.project_path LIKE ?");
            params.push(`${String(args.project)}%`);
          }
          if (args.status) {
            clauses.push("w.status = ?");
            params.push(String(args.status));
          }
          if (args.since) {
            const ts = parseSince(String(args.since));
            if (ts === null) {
              throw Errors.invalidInput(
                `--since must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${args.since}')`,
              );
            }
            clauses.push("w.started_at >= ?");
            params.push(ts);
          }

          const whereSql = clauses.length
            ? `WHERE ${clauses.join(" AND ")}`
            : "";
          params.push(limit);

          const rows = db
            .prepare<unknown[], Record<string, unknown>>(
              `SELECT w.run_id, w.workflow_name, w.status, w.agent_count,
                      w.total_tokens, w.total_tool_calls, w.duration_ms,
                      w.started_at, w.summary, w.orchestrating_session_id,
                      s.project_path
                 FROM workflow_runs w
                 LEFT JOIN sessions s ON s.id = w.orchestrating_session_id
                 ${whereSql}
                 ORDER BY ${orderBy}, w.run_id
                 LIMIT ?`,
            )
            .all(...params)
            .map(enrichRunRow);
          return { data: { rows, limit, sort: sortKey } };
        } finally {
          db.close();
        }
      },
    });
  },
});

function enrichRunRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    started_at_iso: epochToIso(row["started_at"]),
    reconstruct_command:
      typeof row["run_id"] === "string"
        ? `agentmine workflow ${row["run_id"]}`
        : null,
  };
}

function epochToIso(value: unknown): string | null {
  return typeof value === "number"
    ? new Date(value * 1000).toISOString()
    : null;
}

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000) return fallback;
  return n;
}
