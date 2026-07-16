import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../src/extensions.js";

describe("loadExtensions", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `agentmine-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when file is absent", async () => {
    const config = await loadExtensions(join(dir, "extensions.js"));
    expect(config).toEqual({});
  });

  it("loads adapters from a valid extension file", async () => {
    const extPath = join(dir, "extensions.js");
    writeFileSync(
      extPath,
      `export default { adapters: [{ name: "test-adapter", rootPath: "/tmp", listFiles: async () => [], parse: async () => null }] };`,
    );
    const config = await loadExtensions(extPath);
    expect(config.adapters).toHaveLength(1);
    expect(config.adapters?.[0]?.name).toBe("test-adapter");
  });

  it("loads redactPatterns and llmBaseUrl", async () => {
    const extPath = join(dir, "extensions.js");
    writeFileSync(
      extPath,
      `export default { redactPatterns: [{ name: "my-token", pattern: /secret_[a-z]+/g }], llmBaseUrl: "https://proxy.example.com" };`,
    );
    const config = await loadExtensions(extPath);
    expect(config.redactPatterns).toHaveLength(1);
    expect(config.redactPatterns?.[0]?.name).toBe("my-token");
    expect(config.llmBaseUrl).toBe("https://proxy.example.com");
  });

  it("returns empty config and warns when extension file throws", async () => {
    const extPath = join(dir, "extensions.js");
    writeFileSync(extPath, `throw new Error("bad config");`);
    // Should not throw; dynamic import() rejection is caught and warned
    const config = await loadExtensions(extPath);
    expect(config).toEqual({});
  });
});
