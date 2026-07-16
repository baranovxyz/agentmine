/**
 * Vendored LiteLLM pricing snapshot — the offline default for
 * `agentmine prices sync`. Same shape as upstream LiteLLM
 * `model_prices_and_context_window.json` entries (per-token USD), so the
 * offline and `--online` paths share one parser (`parseCostFields`).
 *
 * Source: https://github.com/BerriAI/litellm
 * (`model_prices_and_context_window.json`), captured 2026-06-05. Refresh
 * with `agentmine prices sync --online` to pick up new models; this file is
 * the deterministic fallback that needs no network and ships in the bundle.
 *
 * Trimmed to the cost fields agentmine prices on. Unlisted models resolve to
 * NULL (unpriced) rather than a wrong $0 — add entries here as the corpus
 * grows, or run `--online`.
 */
export interface LiteLLMCostEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

export const PRICE_SNAPSHOT: Record<string, LiteLLMCostEntry> = {
  "claude-opus-4-8": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "claude-opus-4-7": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "claude-opus-4-6": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 25e-6,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "claude-sonnet-4-6": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
  "claude-haiku-4-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
  },
  "gpt-5.4": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 2.5e-7,
  },
};

/** Raw GitHub URL for the live LiteLLM price map (used by `--online`). */
export const LITELLM_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
