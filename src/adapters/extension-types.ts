// src/adapters/extension-types.ts
import type { CanonicalSession } from "./types.js";

/**
 * Public API for agentmine extensions.
 * Load via `~/.config/agentmine/extensions.js`.
 *
 * Built-in source names: "claude-code", "cursor", "opencode", "opencode-db",
 * "codex", "gemini", "qwen", "kilo", "goose", "cline". Extension adapters
 * may use any agent-CLI session source name not in the built-in list.
 */

export interface AdapterRegistration {
  /** Unique source name (e.g. "my-tool"). Must not collide with built-in names. */
  name: string;
  /** Absolute path to the directory containing raw session files. */
  rootPath: string;
  /** Return all parseable file paths under `root`. */
  listFiles(root: string): Promise<string[]>;
  /** Parse a single file into a canonical session, or null if not meaningful. */
  parse(filePath: string): Promise<CanonicalSession | null>;
}

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replace?: (match: string) => string;
}

export interface ExtensionConfig {
  /** Extra source adapters to register alongside built-ins. */
  adapters?: AdapterRegistration[];
  /** Extra redaction rules appended after built-in rules. */
  redactPatterns?: RedactionRule[];
  /** Override base URL for optional local classification calls (e.g. custom proxy). */
  llmBaseUrl?: string;
}
