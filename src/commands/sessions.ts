import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { parseSince } from "./_filters.js";

type Data = Record<string, unknown>;
type Outcome = CommandOutcome<Data>;

/**
 * `agentmine sessions` -- list + filter sessions.
 *
 * Flag design:
 *   --source, --project, --since, --has-subagents, --min-turns   common predicates
 *   --root-only, --parent, --agent-type                          lineage predicates
 *   --where                                                       raw SQL predicate escape hatch
 *
 * `--where` is appended to the WHERE clause. Keep it safe by running the DB in
 * readonly mode and by validating no `;` inside the user input.
 */
export const sessionsCommand = defineCommand({
  meta: {
    name: "sessions",
    description: "List sessions with filters (source, project, since, etc.)",
  },
  args: {
    source: { type: "string", description: "Filter by source" },
    project: { type: "string", description: "Filter by project_path (prefix)" },
    since: {
      type: "string",
      description:
        "ISO date, YYYY-MM-DD, or relative offset (e.g. 7d, 2w); only sessions on/after",
    },
    "has-subagents": {
      type: "boolean",
      default: false,
      description: "Only sessions with at least one normalized direct child",
    },
    "root-only": {
      type: "boolean",
      default: false,
      description: "Only top-level sessions (parent_session_id is null)",
    },
    parent: {
      type: "string",
      description: "Only direct children of this canonical session id",
    },
    "agent-type": {
      type: "string",
      description: "Filter by normalized child agent_type",
    },
    "min-turns": { type: "string", description: "Minimum turn_count" },
    where: {
      type: "string",
      description:
        "Extra SQL predicate, ANDed with other filters (readonly, no ';')",
    },
    limit: { type: "string", default: "50" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine sessions",
      handler: async (): Promise<Outcome> => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const db = openDb({ readonly: true });
        try {
          const limit = parseLimit(args.limit, 50);
          const clauses: string[] = [];
          const params: unknown[] = [];

          if (args.source) {
            clauses.push("source = ?");
            params.push(String(args.source));
          }
          if (args.project) {
            clauses.push("project_path LIKE ?");
            params.push(`${String(args.project)}%`);
          }
          if (args.since) {
            const ts = parseSince(String(args.since));
            if (ts === null) {
              throw Errors.invalidInput(
                `--since must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${args.since}')`,
              );
            }
            clauses.push("started_at >= ?");
            params.push(ts);
          }
          if (args["has-subagents"]) {
            clauses.push(
              `(COALESCE(has_subagents, 0) = 1
                OR EXISTS (
                  SELECT 1 FROM sessions child
                   WHERE child.parent_session_id = sessions.id
                ))`,
            );
          }
          if (args["root-only"]) {
            clauses.push("parent_session_id IS NULL");
          }
          if (args.parent) {
            clauses.push("parent_session_id = ?");
            params.push(String(args.parent));
          }
          if (args["agent-type"]) {
            clauses.push("agent_type = ?");
            params.push(String(args["agent-type"]));
          }
          if (args["min-turns"]) {
            const n = parseLimit(args["min-turns"], 0);
            clauses.push("turn_count >= ?");
            params.push(n);
          }
          if (args.where) {
            const extra = String(args.where);
            if (extra.includes(";")) {
              throw Errors.invalidInput("--where cannot contain ';'");
            }
            clauses.push(`(${extra})`);
          }

          const whereSql = clauses.length
            ? `WHERE ${clauses.join(" AND ")}`
            : "";
          params.push(limit);

          const rows = db
            .prepare<unknown[], Record<string, unknown>>(
              `SELECT id, source, project_path, git_branch, title,
                      started_at, ended_at, first_user_prompt,
                      turn_count, user_turn_count, assistant_turn_count,
                      tool_call_count, tool_error_count,
                      parent_session_id, agent_type,
                      has_subagents, subagent_count
                 FROM sessions
                 ${whereSql}
                 ORDER BY started_at DESC, id
                 LIMIT ?`,
            )
            .all(...params)
            .map(enrichSessionRow);
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

function enrichSessionRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...row,
    started_at_iso: epochToIso(row.started_at),
    ended_at_iso: epochToIso(row.ended_at),
    first_user_prompt_preview:
      typeof row.first_user_prompt === "string"
        ? row.first_user_prompt.slice(0, 240)
        : null,
    reconstruct_command:
      typeof row.id === "string" ? `agentmine session ${row.id} --md` : null,
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
