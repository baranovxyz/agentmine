import { defineCommand } from "citty";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { archiveAlias, archiveExists, attachArchive } from "../db/archives.js";
import { type DatabaseType, dbExists, openDb } from "../db/client.js";
import { withWriteLock } from "../db/lock.js";
import { deleteSession } from "../db/writer.js";
import { extractToolCallNgrams } from "../extract/ngrams.js";
import { extractSubagentInvocations } from "../extract/subagents.js";
import { extractPromptTemplates } from "../extract/templates.js";
import {
  getProjectPathAllowFromEnv,
  type ProjectPathAllowFilter,
  parseProjectPathAllow,
  projectPathMatchesAllow,
} from "../projectPathFilter.js";

type SessionProjectRow = {
  id: string;
  project_path: string | null;
  raw_event_count: number | null;
  tool_output_count: number | null;
};

type PendingPurgeRow = {
  session_id: string;
  raw_event_count: number;
  tool_output_count: number;
};

export const purgeCommand = defineCommand({
  meta: {
    name: "purge",
    description:
      "Purge sessions outside the configured project_path allow filter",
  },
  args: {
    "project-path-allow": {
      type: "string",
      description:
        "Comma-separated project_path substrings to keep; overrides AGENTMINE_PROJECT_PATH_ALLOW",
    },
    yes: {
      type: "boolean",
      default: false,
      description:
        "Actually delete disallowed DB sessions; without this, purge is a dry run",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine purge",
      handler: async () => {
        const dbPath = getDbPath();
        if (!dbExists(dbPath)) {
          throw Errors.notFound(
            `sessions.db not found at ${dbPath}. Run \`agentmine normalize\` first.`,
          );
        }

        const filter =
          args["project-path-allow"] !== undefined
            ? parseProjectPathAllow(args["project-path-allow"])
            : getProjectPathAllowFromEnv();
        if (!filter) {
          throw Errors.invalidInput(
            "Refusing to purge without a project path allow filter. Set " +
              "AGENTMINE_PROJECT_PATH_ALLOW or pass --project-path-allow.",
            "project-path-allow",
          );
        }

        if (!args.yes) {
          const db = openDb({ readonly: true, init: false, path: dbPath });
          try {
            return purgeReceipt(db, filter, dbPath, true);
          } finally {
            db.close();
          }
        }

        return await withWriteLock(
          { command: "agentmine purge", dbPath },
          () => {
            const db = openDb({ path: dbPath });
            try {
              drainPendingPayloadPurges(db, dbPath);
              const result = purgeReceipt(db, filter, dbPath, false);
              drainPendingPayloadPurges(db, dbPath);
              return result;
            } finally {
              db.close();
            }
          },
        );
      },
    });
  },
});

function purgeReceipt(
  db: DatabaseType,
  filter: ProjectPathAllowFilter,
  dbPath: string,
  dryRun: boolean,
): { data: Record<string, unknown> } {
  const rows = db
    .prepare<[], SessionProjectRow>(
      `SELECT id, project_path, raw_event_count, tool_output_count
         FROM sessions ORDER BY id`,
    )
    .all();
  const keep = rows.filter((row) =>
    projectPathMatchesAllow(row.project_path, filter),
  );
  const purge = rows.filter(
    (row) => !projectPathMatchesAllow(row.project_path, filter),
  );

  if (!dryRun && purge.length > 0) stagePurge(db, purge, dbPath);

  return {
    data: {
      matched_keep: keep.length,
      purged: dryRun ? 0 : purge.length,
      would_purge: purge.length,
      dry_run: dryRun,
      db_path: dbPath,
      project_path_allow: filter.raw,
    },
  };
}

/**
 * Commit the hot deletion and durable cold-payload tombstones together.
 * The tombstones make the archive phase resumable after interruption.
 */
function stagePurge(
  db: DatabaseType,
  rows: SessionProjectRow[],
  dbPath: string,
): void {
  const rawExists = archiveExists("raw", dbPath);
  const toolsExist = archiveExists("tools", dbPath);
  if (!rawExists && rows.some((row) => (row.raw_event_count ?? 0) > 0)) {
    throw Errors.dbError(
      "Raw-event archive is missing; refusing to purge hot rows before payload deletion can be proven.",
    );
  }
  if (!toolsExist && rows.some((row) => (row.tool_output_count ?? 0) > 0)) {
    throw Errors.dbError(
      "Tool-output archive is missing; refusing to purge hot rows before payload deletion can be proven.",
    );
  }
  if (rawExists) attachArchive(db, "raw", { dbPath });
  if (toolsExist) attachArchive(db, "tools", { dbPath });
  const insertPending = db.prepare(
    `INSERT INTO pending_payload_purges
       (session_id, raw_event_count, tool_output_count)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       raw_event_count = MAX(raw_event_count, excluded.raw_event_count),
       tool_output_count = MAX(tool_output_count, excluded.tool_output_count)`,
  );
  const deleteChildReference = db.prepare(
    `DELETE FROM subagent_invocations WHERE child_session_id = ?`,
  );
  const clearParentReference = db.prepare(
    `UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?`,
  );
  const clearWorkflowRunReference = db.prepare(
    `UPDATE workflow_runs SET orchestrating_session_id = NULL
      WHERE orchestrating_session_id = ?`,
  );
  const clearWorkflowAgentReference = db.prepare(
    `UPDATE workflow_agents SET agent_session_id = NULL
      WHERE agent_session_id = ?`,
  );

  db.transaction(() => {
    for (const row of rows) {
      insertPending.run(
        row.id,
        row.raw_event_count ?? 0,
        row.tool_output_count ?? 0,
      );
      deleteSession(db, row.id);
      deleteChildReference.run(row.id);
      clearParentReference.run(row.id);
      clearWorkflowRunReference.run(row.id);
      clearWorkflowAgentReference.run(row.id);
    }
    rebuildCorpusAggregates(db);
  })();
}

function rebuildCorpusAggregates(db: DatabaseType): void {
  extractSubagentInvocations(db);
  extractToolCallNgrams(db);
  extractPromptTemplates(db);
  db.prepare(
    `UPDATE sessions SET
       subagent_count = (SELECT COUNT(*) FROM sessions c
                          WHERE c.parent_session_id = sessions.id),
       has_subagents = CASE
         WHEN EXISTS (SELECT 1 FROM sessions c
                       WHERE c.parent_session_id = sessions.id) THEN 1
         ELSE 0
       END`,
  ).run();
}

/** Remove all payload covered by durable tombstones, then clear the tombstones. */
function drainPendingPayloadPurges(db: DatabaseType, dbPath: string): void {
  const pending = db
    .prepare<[], PendingPurgeRow>(
      `SELECT session_id, raw_event_count, tool_output_count
         FROM pending_payload_purges ORDER BY session_id`,
    )
    .all();
  if (pending.length === 0) return;

  const rawExists = archiveExists("raw", dbPath);
  const toolsExist = archiveExists("tools", dbPath);
  if (!rawExists && pending.some((row) => row.raw_event_count > 0)) {
    throw Errors.dbError(
      "Raw-event archive is missing; pending purge cannot prove payload deletion.",
    );
  }
  if (!toolsExist && pending.some((row) => row.tool_output_count > 0)) {
    throw Errors.dbError(
      "Tool-output archive is missing; pending purge cannot prove payload deletion.",
    );
  }

  if (rawExists) attachArchive(db, "raw", { dbPath });
  if (toolsExist) attachArchive(db, "tools", { dbPath });
  const rawDelete = rawExists
    ? db.prepare(
        `DELETE FROM ${archiveAlias("raw")}.raw_events WHERE session_id = ?`,
      )
    : undefined;
  const toolsDelete = toolsExist
    ? db.prepare(
        `DELETE FROM ${archiveAlias("tools")}.tool_outputs WHERE session_id = ?`,
      )
    : undefined;

  for (const row of pending) {
    rawDelete?.run(row.session_id);
    toolsDelete?.run(row.session_id);
  }
  db.transaction(() => {
    const clear = db.prepare(
      `DELETE FROM pending_payload_purges WHERE session_id = ?`,
    );
    for (const row of pending) clear.run(row.session_id);
  })();
}
