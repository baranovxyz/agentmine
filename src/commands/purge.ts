import { defineCommand } from "citty";
import { getDbPath } from "../config.js";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { deleteSession } from "../db/writer.js";
import {
  getProjectPathAllowFromEnv,
  parseProjectPathAllow,
  projectPathMatchesAllow,
} from "../projectPathFilter.js";

type SessionProjectRow = {
  id: string;
  project_path: string | null;
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

        const dryRun = !args.yes;
        const db = openDb({ readonly: dryRun, init: false, path: dbPath });
        try {
          const rows = db
            .prepare<[], SessionProjectRow>(
              `SELECT id, project_path FROM sessions ORDER BY id`,
            )
            .all();
          const keep = rows.filter((row) =>
            projectPathMatchesAllow(row.project_path, filter),
          );
          const purge = rows.filter(
            (row) => !projectPathMatchesAllow(row.project_path, filter),
          );

          if (!dryRun && purge.length > 0) {
            const deleteMany = db.transaction((ids: string[]) => {
              for (const id of ids) deleteSession(db, id);
            });
            deleteMany(purge.map((row) => row.id));
          }

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
        } finally {
          db.close();
        }
      },
    });
  },
});
