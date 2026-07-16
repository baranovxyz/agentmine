import { defineCommand } from "citty";
import { z } from "zod";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { VERSION } from "../version.js";

// The schema command emits the stable envelope description and command names.
const CommandRegistry = z.object({
  tool: z.literal("agentmine"),
  version: z.string(),
  outputVersion: z.number(),
  envelope: z.object({
    version: z.number(),
    status: z.enum(["success", "partial", "error"]),
    command: z.string(),
    data: z.any().nullable(),
    errors: z
      .array(
        z.object({
          code: z.number(),
          name: z.string(),
          message: z.string(),
          category: z.enum(["user", "system", "transient"]),
          retryable: z.boolean(),
        }),
      )
      .optional(),
    warnings: z
      .array(z.object({ name: z.string(), message: z.string() }))
      .optional(),
    traceId: z.string(),
  }),
  exitCodes: z.record(z.string(), z.string()),
  commands: z.record(
    z.string(),
    z.object({
      description: z.string(),
      annotations: z.object({
        readOnlyHint: z.boolean(),
        destructiveHint: z.boolean(),
        idempotentHint: z.boolean(),
      }),
    }),
  ),
});

export const schemaCommand = defineCommand({
  meta: {
    name: "schema",
    description:
      "Emit agent discovery metadata and the result-envelope JSON Schema",
  },
  args: {
    tables: {
      type: "boolean",
      default: false,
      description: "List database tables and views",
    },
    table: {
      type: "string",
      description: "Describe one database table or view",
    },
  },
  async run({ args }) {
    await runCommand<Record<string, unknown>>({
      command: "agentmine schema",
      handler: async () => {
        if (args.tables || args.table) {
          if (!dbExists()) {
            throw Errors.notFound(
              "sessions.db not found. Run `agentmine normalize` first.",
            );
          }
          const db = openDb({ readonly: true });
          try {
            if (args.table) {
              return { data: describeTable(db, String(args.table)) };
            }
            return { data: listTables(db) };
          } finally {
            db.close();
          }
        }

        const data = {
          tool: "agentmine" as const,
          version: VERSION,
          outputVersion: 1,
          envelope: z.toJSONSchema(CommandRegistry.shape.envelope),
          exitCodes: {
            "0": "Success",
            "1": "Partial success",
            "2": "User error",
            "3": "System error",
            "4": "Transient (retry with backoff)",
            "5": "Conflict (no-op / already exists)",
          },
          commands: {
            schema: {
              description:
                "Emit agent discovery metadata and the result-envelope JSON Schema",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            backup: {
              description:
                "Create a consistent SQLite backup archive under the app-data sessions backup directory or --output",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
              },
            },
            sync: {
              description:
                "Rsync raw sessions from source directories; optionally extract Claude Code history tarballs with --claude-history or --discover-claude-history",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            ingest: {
              description:
                "Run sync, normalize, and extract as one idempotent import workflow",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            normalize: {
              description:
                "Parse raw sessions into canonical SQLite tables; AGENTMINE_PROJECT_PATH_ALLOW filters project_path by comma-separated substrings",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            purge: {
              description:
                "Delete DB sessions whose project_path does not match --project-path-allow or AGENTMINE_PROJECT_PATH_ALLOW; dry-run unless --yes is passed",
              annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
              },
            },
            extract: {
              description: "Populate deterministic fact + pattern tables",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            embed: {
              description:
                "Build or inspect the local embedding index for semantic session retrieval",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            stats: {
              description: "Overview of corpus size and coverage",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            top: {
              description:
                "Corpus aggregates for files, commands, corrections, skills, MCP, web, sequences, prompts, errors, subagents, self-resolutions, and tokens",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            query: {
              description: "Ad-hoc SQL against sessions.db",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            fts: {
              description: "Full-text search over normalized messages",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            similar: {
              description:
                "Find prior sessions similar to a task description and return reconstruction commands",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            session: {
              description: "Render one session transcript",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            sessions: {
              description:
                "List sessions with filters and reconstruction commands",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            timeline: {
              description: "Session count over time, grouped by source",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            prices: {
              description:
                "Manage the local model price table used for token-cost reporting",
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            workflows: {
              description:
                "List Claude Code workflow runs with filters and ranking",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
            workflow: {
              description:
                "Inspect one workflow run with rollups, phases, and per-agent rows",
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
              },
            },
          },
        };
        return { data };
      },
    });
  },
});

type SqliteObjectRow = {
  name: string;
  type: "table" | "view";
  sql: string | null;
};

function listTables(db: ReturnType<typeof openDb>): {
  tables: string[];
  views: string[];
  [key: string]: unknown;
} {
  const rows = db
    .prepare<[], SqliteObjectRow>(
      `SELECT name, type, sql
         FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    )
    .all();
  const visibleRows = rows.filter((row) => !isInternalTable(row.name));
  return {
    tables: visibleRows
      .filter((row) => row.type === "table")
      .map((row) => row.name),
    views: rows.filter((row) => row.type === "view").map((row) => row.name),
  };
}

function describeTable(
  db: ReturnType<typeof openDb>,
  name: string,
): {
  table: string;
  type: "table" | "view";
  columns: unknown[];
  indexes: unknown[];
  create_sql: string | null;
  [key: string]: unknown;
} {
  const objects = db
    .prepare<[], SqliteObjectRow>(
      `SELECT name, type, sql
         FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all();
  const visibleObjects = objects.filter(
    (row) => row.type === "view" || !isInternalTable(row.name),
  );
  const object = visibleObjects.find((row) => row.name === name);
  if (!object) {
    const suggestions = suggestNames(
      name,
      visibleObjects.map((row) => row.name),
    );
    throw Errors.invalidInput(
      `Unknown table or view '${name}'${suggestions.length ? `. Did you mean: ${suggestions.join(", ")}?` : ""}`,
    );
  }
  const quoted = quoteIdentifier(object.name);
  const columns = db.pragma(`table_info(${quoted})`) as unknown[];
  const indexes = db.pragma(`index_list(${quoted})`) as unknown[];
  return {
    table: object.name,
    type: object.type,
    columns,
    indexes,
    create_sql: object.sql,
  };
}

function isInternalTable(name: string): boolean {
  return /^messages_fts_(config|data|docsize|idx)$/.test(name);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function suggestNames(input: string, names: string[]): string[] {
  const lower = input.toLowerCase();
  return names
    .filter(
      (name) =>
        name.toLowerCase().includes(lower) ||
        lower.includes(name.toLowerCase()),
    )
    .slice(0, 5);
}
