import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

export const statsCommand = defineCommand({
  meta: {
    name: "stats",
    description: "Overview of corpus size and coverage",
  },
  async run() {
    await runCommand({
      command: "agentmine stats",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine sync` then `agentmine normalize` first.",
          );
        }
        const db = openDb({ readonly: true });
        try {
          const totals = db
            .prepare<[], Record<string, number>>(
              `SELECT
                 (SELECT COUNT(*) FROM sessions) AS sessions,
                 (SELECT COUNT(*) FROM messages) AS messages,
                 (SELECT COUNT(*) FROM tool_calls) AS tool_calls,
                 (SELECT COUNT(*) FROM files_touched) AS file_touch_events,
                 (SELECT COUNT(DISTINCT path) FROM files_touched) AS files_touched,
                 (SELECT COUNT(*) FROM shell_commands) AS shell_commands,
                 (SELECT COUNT(*) FROM user_corrections) AS user_corrections,
                 (SELECT COUNT(*) FROM tool_errors) AS tool_errors,
                 (SELECT COUNT(*) FROM raw_events) AS raw_events,
                 (SELECT COUNT(*) FROM tool_outputs) AS full_tool_outputs`,
            )
            .get();

          const bySource = db
            .prepare<
              [],
              {
                source: string;
                sessions: number;
                turns: number | null;
                tool_calls: number | null;
              }
            >(
              `SELECT source, COUNT(*) AS sessions,
                      SUM(turn_count) AS turns,
                      SUM(tool_call_count) AS tool_calls
                 FROM sessions GROUP BY source ORDER BY source`,
            )
            .all();

          const dateRange = db
            .prepare<[], { min_ts: number | null; max_ts: number | null }>(
              `SELECT MIN(started_at) AS min_ts, MAX(started_at) AS max_ts FROM sessions`,
            )
            .get();

          const topProjects = db
            .prepare<[], { project_path: string; sessions: number }>(
              `SELECT project_path, COUNT(*) AS sessions
                 FROM sessions WHERE project_path IS NOT NULL
                 GROUP BY project_path ORDER BY sessions DESC LIMIT 10`,
            )
            .all();

          return {
            data: {
              totals,
              by_source: bySource,
              date_range: {
                earliest: dateRange?.min_ts
                  ? new Date(dateRange.min_ts * 1000).toISOString()
                  : null,
                latest: dateRange?.max_ts
                  ? new Date(dateRange.max_ts * 1000).toISOString()
                  : null,
              },
              top_projects: topProjects,
            },
          };
        } finally {
          db.close();
        }
      },
    });
  },
});
