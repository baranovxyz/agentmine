import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { withWriteLock } from "../db/lock.js";
import { runAllExtractors } from "../extract/index.js";

export const extractCommand = defineCommand({
  meta: {
    name: "extract",
    description:
      "Populate fact tables (files_touched, shell_commands, user_corrections, tool_errors)",
  },
  async run() {
    await runCommand({
      command: "agentmine extract",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        reportProgressImmediate("extract.start");
        const counts = await withWriteLock(
          { command: "agentmine extract" },
          () => {
            const db = openDb();
            try {
              return runAllExtractors(db);
            } finally {
              db.close();
            }
          },
        );
        reportProgressImmediate("extract.done", counts);
        return { data: counts };
      },
    });
  },
});
