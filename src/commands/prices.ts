import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { reportProgressImmediate } from "../contract/progress.js";
import { runCommand } from "../contract/result.js";
import { type DatabaseType, dbExists, openDb } from "../db/client.js";
import {
  fetchLiteLLMPrices,
  type RawPriceMap,
  resolvePrice,
} from "../prices/litellm.js";
import { PRICE_SNAPSHOT } from "../prices/snapshot.js";

/** Models that are not real priced LLMs. */
const SKIP_MODELS = new Set(["<synthetic>"]);

export interface PriceSyncResult {
  source: "snapshot" | "litellm";
  models: number;
  priced: number;
  unpriced: string[];
}

/**
 * Resolve every distinct corpus model against `map` and upsert one row per
 * exact corpus model string into `model_prices`. Normalization (date-suffix
 * stripping, alias resolution) happens here so `top tokens` can join on the
 * raw `sessions.model` string. Unmatched models get a NULL-price row so they
 * surface as unpriced rather than silently $0. Idempotent.
 */
export function syncPrices(
  db: DatabaseType,
  map: RawPriceMap,
  source: PriceSyncResult["source"],
): PriceSyncResult {
  const models = db
    .prepare<[], { model: string }>(
      `SELECT DISTINCT model FROM sessions WHERE model IS NOT NULL AND model <> ''`,
    )
    .all()
    .map((r) => r.model)
    .filter((m) => !SKIP_MODELS.has(m));

  const upsert = db.prepare(
    `INSERT INTO model_prices
       (model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
        cache_write_per_mtok, matched_key, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       cache_read_per_mtok = excluded.cache_read_per_mtok,
       cache_write_per_mtok = excluded.cache_write_per_mtok,
       matched_key = excluded.matched_key,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  );

  const now = Math.floor(Date.now() / 1000);
  const unpriced: string[] = [];
  const tx = db.transaction(() => {
    for (const model of models) {
      const { matchedKey, price } = resolvePrice(model, map);
      if (!price) unpriced.push(model);
      upsert.run(
        model,
        price?.inputPerMtok ?? null,
        price?.outputPerMtok ?? null,
        price?.cacheReadPerMtok ?? null,
        price?.cacheWritePerMtok ?? null,
        matchedKey,
        source,
        now,
      );
    }
  });
  tx();

  return {
    source,
    models: models.length,
    priced: models.length - unpriced.length,
    unpriced,
  };
}

const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description:
      "Load model_prices from the vendored LiteLLM snapshot (offline default) or live LiteLLM (--online). Required before `top tokens` shows USD cost.",
  },
  args: {
    online: {
      type: "boolean",
      default: false,
      description:
        "Fetch the live LiteLLM price map instead of the vendored snapshot",
    },
  },
  async run({ args }) {
    await runCommand({
      command: "agentmine prices sync",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const online = Boolean(args.online);
        reportProgressImmediate("prices.start", {
          source: online ? "litellm" : "snapshot",
        });
        const map: RawPriceMap = online
          ? await fetchLiteLLMPrices(process.env.AGENTMINE_LITELLM_PRICE_URL)
          : PRICE_SNAPSHOT;
        const db = openDb();
        try {
          const result = syncPrices(db, map, online ? "litellm" : "snapshot");
          reportProgressImmediate("prices.done", { ...result });
          return {
            data: result,
            ...(result.unpriced.length > 0
              ? {
                  warnings: [
                    {
                      name: "UNPRICED_MODELS",
                      message: `No price for ${result.unpriced.length} model(s): ${result.unpriced.join(", ")}. Their token cost reads as 0 in \`top tokens\`. Add them to the snapshot or run \`prices sync --online\`.`,
                    },
                  ],
                }
              : {}),
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

const lsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List the loaded model_prices table (USD per 1M tokens)",
  },
  async run() {
    await runCommand({
      command: "agentmine prices ls",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine normalize` first.",
          );
        }
        const db = openDb({ readonly: true });
        try {
          const rows = db
            .prepare(
              `SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok,
                      cache_write_per_mtok, matched_key, source, updated_at
                 FROM model_prices ORDER BY model`,
            )
            .all();
          return { data: { rows, count: rows.length } };
        } finally {
          db.close();
        }
      },
    });
  },
});

export const pricesCommand = defineCommand({
  meta: {
    name: "prices",
    description:
      "Manage the local model price table (sourced from LiteLLM, the same data ccusage uses)",
  },
  subCommands: {
    sync: syncCommand,
    ls: lsCommand,
  },
});
