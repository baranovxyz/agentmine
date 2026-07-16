/**
 * LiteLLM price resolution — shared by the offline snapshot and the
 * `--online` live fetch. Both produce the same `{model: rawEntry}` map; this
 * module turns a raw entry into per-1M-token USD and resolves a corpus model
 * string to its price (with date-suffix normalization).
 */
import { z } from "zod";
import { Errors } from "../contract/errors.js";
import { LITELLM_PRICE_URL } from "./snapshot.js";

/** Cost fields agentmine reads from a LiteLLM entry. All optional. */
const CostFieldsSchema = z
  .object({
    input_cost_per_token: z.number().nonnegative().optional(),
    output_cost_per_token: z.number().nonnegative().optional(),
    cache_read_input_token_cost: z.number().nonnegative().optional(),
    cache_creation_input_token_cost: z.number().nonnegative().optional(),
  })
  .passthrough();

/** A raw price map: model key -> arbitrary entry (validated per-entry). */
const RawPriceMapSchema = z.record(z.string(), z.unknown());

export type RawPriceMap = z.infer<typeof RawPriceMapSchema>;

/** Per-1M-token USD prices. `null` = the source did not list that field. */
export interface ModelPrice {
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cacheReadPerMtok: number | null;
  cacheWritePerMtok: number | null;
}

const perMtok = (perToken: number | undefined): number | null =>
  perToken === undefined ? null : perToken * 1_000_000;

/**
 * Parse a raw LiteLLM entry into per-1M-token USD. Returns null when the
 * entry carries none of the four cost fields (i.e. nothing to price on).
 */
export function parseCostFields(raw: unknown): ModelPrice | null {
  const parsed = CostFieldsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data;
  if (
    c.input_cost_per_token === undefined &&
    c.output_cost_per_token === undefined &&
    c.cache_read_input_token_cost === undefined &&
    c.cache_creation_input_token_cost === undefined
  ) {
    return null;
  }
  return {
    inputPerMtok: perMtok(c.input_cost_per_token),
    outputPerMtok: perMtok(c.output_cost_per_token),
    cacheReadPerMtok: perMtok(c.cache_read_input_token_cost),
    cacheWritePerMtok: perMtok(c.cache_creation_input_token_cost),
  };
}

/**
 * Drop a trailing date stamp so dated model strings resolve to their base
 * LiteLLM key: `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`,
 * `gpt-5.4-pro-2026-03-05` -> `gpt-5.4-pro`.
 */
export function normalizeModel(model: string): string {
  return model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
}

export interface ResolvedPrice {
  matchedKey: string | null;
  price: ModelPrice | null;
}

/**
 * Resolve a corpus model string against a price map: try the exact string,
 * then the date-normalized form. Unmatched -> `{matchedKey: null, price: null}`.
 */
export function resolvePrice(model: string, map: RawPriceMap): ResolvedPrice {
  for (const key of [model, normalizeModel(model)]) {
    if (Object.hasOwn(map, key)) {
      const price = parseCostFields(map[key]);
      if (price) return { matchedKey: key, price };
    }
  }
  return { matchedKey: null, price: null };
}

/** Fetch the live LiteLLM price map (the source ccusage uses). */
export async function fetchLiteLLMPrices(
  url: string = LITELLM_PRICE_URL,
): Promise<RawPriceMap> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw Errors.network(
      `Failed to fetch LiteLLM prices from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw Errors.network(
      `Failed to fetch LiteLLM prices from ${url}: HTTP ${res.status}`,
    );
  }
  const json: unknown = await res.json();
  const parsed = RawPriceMapSchema.safeParse(json);
  if (!parsed.success) {
    throw Errors.network(
      `LiteLLM price payload was not a JSON object: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
