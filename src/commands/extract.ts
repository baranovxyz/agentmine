import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { dbExists, getMeta, openDb, upsertMeta } from "../db/client.js";
import {
  clearWorkflowExtractionPending,
  recordExtractSuccess,
  workflowExtractionIsPending,
} from "../db/freshness.js";
import { withWriteLock } from "../db/lock.js";
import {
  clearAllDirtySessions,
  clearDirtySessions,
  getDirtySessions,
} from "../db/writer.js";
import { runAllExtractors } from "../extract/index.js";
import { extractWorkflowRuns } from "../extract/workflows.js";

/**
 * Marker set after any full rebuild. Its absence means the corpus predates
 * incremental extract (or was never extracted), so the first run must be a full
 * rebuild before the dirty-set can be trusted.
 */
const EXTRACT_READY_META_KEY = "extract_incremental_ready";

export const extractCommand = defineCommand({
  meta: {
    name: "extract",
    description:
      "Populate fact tables (files_touched, shell_commands, user_corrections, tool_errors). Incremental over sessions changed since the last run; use --force for a full rebuild.",
  },
  args: {
    force: {
      type: "boolean",
      default: false,
      description:
        "Rebuild every fact table from the whole corpus, ignoring the dirty set",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine extract",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        reportProgressImmediate("extract.start");
        const result = await withWriteLock(
          { command: "agentmine extract" },
          () => {
            const db = openDb();
            try {
              const ready = getMeta(db, EXTRACT_READY_META_KEY) === "1";
              const full = Boolean(args.force) || !ready;

              if (full) {
                const counts = runAllExtractors(db, null);
                clearAllDirtySessions(db);
                clearWorkflowExtractionPending(db);
                upsertMeta(db, EXTRACT_READY_META_KEY, "1");
                recordExtractSuccess(db);
                return { counts, scope: "full" as const, sessions_scoped: 0 };
              }

              const dirty = getDirtySessions(db);
              const workflowPending = workflowExtractionIsPending(db);
              if (dirty.length === 0 && !workflowPending) {
                recordExtractSuccess(db);
                return {
                  counts: null,
                  scope: "incremental" as const,
                  sessions_scoped: 0,
                };
              }

              if (dirty.length === 0) {
                const workflow_runs = extractWorkflowRuns(db);
                clearWorkflowExtractionPending(db);
                recordExtractSuccess(db);
                return {
                  counts: { workflow_runs },
                  scope: "incremental" as const,
                  sessions_scoped: 0,
                };
              }

              const counts = runAllExtractors(db, dirty);
              clearDirtySessions(db, dirty);
              clearWorkflowExtractionPending(db);
              recordExtractSuccess(db);
              return {
                counts,
                scope: "incremental" as const,
                sessions_scoped: dirty.length,
              };
            } finally {
              db.close();
            }
          },
        );
        reportProgressImmediate("extract.done", {
          scope: result.scope,
          sessions_scoped: result.sessions_scoped,
        });
        return {
          data: {
            scope: result.scope,
            sessions_scoped: result.sessions_scoped,
            skipped: result.counts === null,
            ...(result.counts ?? {}),
          },
        };
      },
    });
  },
});
