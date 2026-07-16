import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionConfig } from "./adapters/extension-types.js";

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "agentmine",
  "extensions.js",
);

/**
 * Load the user's local extension config from `~/.config/agentmine/extensions.js`
 * (or a custom path for testing).
 *
 * - Absent file → returns `{}` silently.
 * - Load error → warns to stderr, returns `{}`.
 * - Never throws.
 */
export async function loadExtensions(
  configPath = DEFAULT_CONFIG_PATH,
): Promise<ExtensionConfig> {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const mod = await import(configPath);
    const ext: unknown = mod.default ?? mod;
    if (typeof ext !== "object" || ext === null) {
      return {};
    }
    const e = ext as Record<string, unknown>;
    return {
      adapters: Array.isArray(e["adapters"]) ? e["adapters"] : undefined,
      redactPatterns: Array.isArray(e["redactPatterns"])
        ? e["redactPatterns"]
        : undefined,
      llmBaseUrl:
        typeof e["llmBaseUrl"] === "string" ? e["llmBaseUrl"] : undefined,
    };
  } catch (err) {
    process.stderr.write(
      `[agentmine] Warning: failed to load extensions from ${configPath}: ${String(err)}\n`,
    );
    return {};
  }
}
