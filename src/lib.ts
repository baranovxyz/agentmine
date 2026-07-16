/**
 * Public library exports for agentmine extensions.
 *
 * Extensions loaded from `~/.config/agentmine/extensions.js` can import
 * adapters and utilities from the built `dist/lib.js`:
 *
 *   import { parseClaudeCodeFile, walkJsonl } from '<agentmine>/dist/lib.js';
 */

export type {
  AdapterOptions,
  CursorAdapterOptions,
} from "./adapters/canonical.js";
export {
  parseClaudeCodeFile,
  parseCursorFile,
} from "./adapters/canonical.js";
export type {
  AdapterRegistration,
  ExtensionConfig,
} from "./adapters/extension-types.js";
export type {
  CanonicalSession,
  Message,
  MessagePart,
  ToolCall,
} from "./adapters/types.js";

// Re-export a recursive JSONL walker so extensions don't have to reimplement it.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  await walk(dir, out);
  return out;
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const st = await stat(full);
        if (st.size > 0) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
}
