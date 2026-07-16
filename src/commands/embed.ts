import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { withWriteLock } from "../db/lock.js";
import { runEmbed } from "../embeddings/index.js";
import { parseSince } from "./_filters.js";

export const embedCommand = defineCommand({
  meta: {
    name: "embed",
    description:
      "Build or inspect a local embedding index for agentmine sessions",
  },
  args: {
    provider: {
      type: "string",
      default: "ollama",
      description: "Embedding provider: fake|ollama",
    },
    model: { type: "string", description: "Embedding model name" },
    "dry-run": {
      type: "boolean",
      default: false,
      description:
        "Plan embedding work without provider calls or embedding writes",
    },
    since: {
      type: "string",
      description:
        "Only embed chunks from sessions started on/after this point (ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h)",
    },
    limit: {
      type: "string",
      default: "100",
      description: "Maximum pending chunks to embed",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine embed",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine sync` + `agentmine normalize` first.",
          );
        }
        const providerName = String(args.provider ?? "ollama");
        const model = String(
          args.model ?? (providerName === "fake" ? "fake" : "nomic-embed-text"),
        );
        const limit = parseLimit(args.limit, 100);
        let sinceEpoch: number | undefined;
        if (args.since) {
          const ts = parseSince(String(args.since));
          if (ts === null) {
            throw Errors.invalidInput(
              `--since must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${args.since}')`,
            );
          }
          sinceEpoch = ts;
        }
        const dryRun = Boolean(args["dry-run"]);
        // Serialize embedding writes against other agentmine writers. A dry run
        // writes no chunks/vectors/receipts, so it skips the lock.
        const runEmbedOnce = async () => {
          const db = openDb({ readonly: false });
          try {
            const data = await runEmbed(db, {
              providerName,
              model,
              dryRun,
              limit,
              sinceEpoch,
            });
            return {
              status:
                data.status === "partial"
                  ? ("partial" as const)
                  : ("success" as const),
              data,
            };
          } finally {
            db.close();
          }
        };
        return dryRun
          ? await runEmbedOnce()
          : await withWriteLock({ command: "agentmine embed" }, runEmbedOnce);
      },
    });
  },
});

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000) return fallback;
  return n;
}
