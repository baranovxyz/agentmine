import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

type Data = Record<string, unknown>;
type Outcome = CommandOutcome<Data>;

/**
 * `agentmine timeline` -- sessions-per-bucket histogram, optionally filtered by
 * project and/or source. Bucket can be `day`, `week`, or `month`.
 */
export const timelineCommand = defineCommand({
  meta: {
    name: "timeline",
    description: "Session count over time, grouped by source",
  },
  args: {
    project: { type: "string", description: "Filter by project_path (prefix)" },
    source: { type: "string", description: "Filter by source" },
    bucket: { type: "string", default: "month", description: "day|week|month" },
    limit: { type: "string", default: "200" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine timeline",
      handler: async (): Promise<Outcome> => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const db = openDb({ readonly: true });
        try {
          const bucket = String(args.bucket);
          const fmt =
            bucket === "day"
              ? "%Y-%m-%d"
              : bucket === "week"
                ? "%Y-W%W"
                : bucket === "month"
                  ? "%Y-%m"
                  : null;
          if (!fmt) {
            throw Errors.invalidInput(
              `--bucket must be day|week|month (got '${bucket}')`,
            );
          }
          const limit = parseLimit(args.limit, 200);
          const clauses: string[] = ["started_at IS NOT NULL"];
          const params: unknown[] = [];
          if (args.project) {
            clauses.push("project_path LIKE ?");
            params.push(`${String(args.project)}%`);
          }
          if (args.source) {
            clauses.push("source = ?");
            params.push(String(args.source));
          }
          params.push(limit);
          const rows = db
            .prepare(
              `SELECT strftime('${fmt}', started_at, 'unixepoch') AS bucket,
                      source,
                      COUNT(*) AS sessions,
                      SUM(COALESCE(tool_call_count, 0)) AS tool_calls
                 FROM sessions
                WHERE ${clauses.join(" AND ")}
                GROUP BY bucket, source
                ORDER BY bucket DESC, source
                LIMIT ?`,
            )
            .all(...params);
          return { data: { rows, bucket, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000) return fallback;
  return n;
}
