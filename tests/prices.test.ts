import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncPrices } from "../src/commands/prices.js";
import { openDb } from "../src/db/client.js";
import {
  normalizeModel,
  parseCostFields,
  resolvePrice,
} from "../src/prices/litellm.js";
import { PRICE_SNAPSHOT } from "../src/prices/snapshot.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentmine-prices-")), "test.db");
}

describe("normalizeModel", () => {
  it("strips a compact date suffix", () => {
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5",
    );
  });
  it("strips a dashed date suffix", () => {
    expect(normalizeModel("gpt-5.4-pro-2026-03-05")).toBe("gpt-5.4-pro");
  });
  it("leaves a plain model untouched", () => {
    expect(normalizeModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

describe("parseCostFields", () => {
  it("converts per-token to per-1M-token USD", () => {
    expect(
      parseCostFields({
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        cache_read_input_token_cost: 5e-7,
        cache_creation_input_token_cost: 6.25e-6,
      }),
    ).toEqual({
      inputPerMtok: 5,
      outputPerMtok: 25,
      cacheReadPerMtok: 0.5,
      cacheWritePerMtok: 6.25,
    });
  });
  it("returns null when no cost fields are present", () => {
    expect(parseCostFields({ max_tokens: 200000 })).toBeNull();
  });
  it("leaves missing cost fields null", () => {
    expect(parseCostFields({ input_cost_per_token: 2.5e-6 })).toEqual({
      inputPerMtok: 2.5,
      outputPerMtok: null,
      cacheReadPerMtok: null,
      cacheWritePerMtok: null,
    });
  });
});

describe("resolvePrice", () => {
  it("matches an exact key", () => {
    const r = resolvePrice("claude-opus-4-8", PRICE_SNAPSHOT);
    expect(r.matchedKey).toBe("claude-opus-4-8");
    expect(r.price?.inputPerMtok).toBe(5);
  });
  it("matches via date normalization", () => {
    const r = resolvePrice("claude-haiku-4-5-20251001", PRICE_SNAPSHOT);
    expect(r.matchedKey).toBe("claude-haiku-4-5");
    expect(r.price?.outputPerMtok).toBe(5);
  });
  it("returns nulls for an unknown model", () => {
    const r = resolvePrice("minimax-m3-free", PRICE_SNAPSHOT);
    expect(r.matchedKey).toBeNull();
    expect(r.price).toBeNull();
  });
});

describe("syncPrices", () => {
  function seed(db: ReturnType<typeof openDb>): void {
    const insert = db.prepare(
      `INSERT INTO sessions
         (id, source, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "cc--1",
      "claude-code",
      "claude-opus-4-8",
      1_000_000,
      1_000_000,
      10_000_000,
      1_000_000,
    );
    insert.run(
      "cc--2",
      "claude-code",
      "minimax-m3-free",
      500_000,
      500_000,
      0,
      0,
    );
    insert.run(
      "cc--3",
      "claude-code",
      "claude-haiku-4-5-20251001",
      1_000_000,
      0,
      0,
      0,
    );
    insert.run("cc--4", "claude-code", "<synthetic>", 1, 1, 0, 0);
  }

  it("prices known models and reports unpriced ones (skipping <synthetic>)", () => {
    const db = openDb({ path: tmpDbPath() });
    seed(db);
    const result = syncPrices(db, PRICE_SNAPSHOT, "snapshot");
    expect(result.source).toBe("snapshot");
    expect(result.models).toBe(3); // <synthetic> skipped
    expect(result.priced).toBe(2);
    expect(result.unpriced).toEqual(["minimax-m3-free"]);
    db.close();
  });

  it("computes USD cost via the model_prices join", () => {
    const db = openDb({ path: tmpDbPath() });
    seed(db);
    syncPrices(db, PRICE_SNAPSHOT, "snapshot");
    const costFor = (id: string): number | null =>
      db
        .prepare<[string], { cost: number | null }>(
          `SELECT ROUND(SUM(
              COALESCE(s.input_tokens,0)*COALESCE(p.input_per_mtok,0)
            + COALESCE(s.output_tokens,0)*COALESCE(p.output_per_mtok,0)
            + COALESCE(s.cache_read_tokens,0)*COALESCE(p.cache_read_per_mtok,0)
            + COALESCE(s.cache_creation_tokens,0)*COALESCE(p.cache_write_per_mtok,0))/1e6, 4) AS cost
             FROM sessions s LEFT JOIN model_prices p ON p.model = s.model
            WHERE s.id = ?`,
        )
        .get(id)?.cost ?? null;
    // opus-4-8: 1M*$5 + 1M*$25 + 10M*$0.5 + 1M*$6.25 = $41.25
    expect(costFor("cc--1")).toBeCloseTo(41.25, 4);
    // unpriced model contributes $0
    expect(costFor("cc--2")).toBe(0);
    db.close();
  });

  it("is idempotent", () => {
    const path = tmpDbPath();
    const db = openDb({ path });
    seed(db);
    syncPrices(db, PRICE_SNAPSHOT, "snapshot");
    syncPrices(db, PRICE_SNAPSHOT, "snapshot");
    const count = db
      .prepare<[], { c: number }>(`SELECT COUNT(*) AS c FROM model_prices`)
      .get();
    expect(count?.c).toBe(3);
    db.close();
  });
});
