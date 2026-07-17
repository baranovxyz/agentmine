/**
 * Compat wrappers: shared agent-canonical parsers → agentmine's flat
 * CanonicalSession shape.
 *
 * This is the seam between the shared parsers' layered Result API and the
 * legacy `CanonicalSession | null` contract that agentmine's DB writer and
 * normalize command expect. Issues are swallowed here — callers that need
 * them should use the shared parsers directly. Incremental readers are a
 * separate, capability-based surface and are not used by Agentmine ingest.
 *
 */

import { createHash } from "node:crypto";
import {
  type ClaudeCodeParseOptions,
  parseSessionFile as parseClaudeCodeSessionFile,
} from "agent-canonical/parsers/claude-code";
import { parseSessionFile as parseClineSessionFile } from "agent-canonical/parsers/cline";
import { parseSessionFile as parseCodexSessionFile } from "agent-canonical/parsers/codex";
import { parseSessionFile as parseCopilotSessionFile } from "agent-canonical/parsers/copilot";
import {
  type CursorParseOptions,
  parseSessionFile as parseCursorSessionFile,
} from "agent-canonical/parsers/cursor";
import { parseSessionFile as parseGeminiSessionFile } from "agent-canonical/parsers/gemini";
import {
  type GooseDb,
  listSessionIds as listGooseDbSessionIds,
  parseSessionFromDb as parseGooseDbSession,
} from "agent-canonical/parsers/goose";
import {
  type KiloDb,
  listSessionIds as listKiloDbSessionIds,
  parseSessionFromDb as parseKiloDbSession,
} from "agent-canonical/parsers/kilo";
import {
  listSessionIds,
  type OpencodeDb,
  type OpencodeParseOptions,
  parseSessionFile as parseOpencodeSessionFile,
  parseSessionFromDb,
} from "agent-canonical/parsers/opencode";
import { parseSessionFile as parseQwenSessionFile } from "agent-canonical/parsers/qwen";
import type { Session } from "agent-canonical/schemas";
import type { CanonicalSession } from "./types.js";

// ---------------------------------------------------------------------------
// flattenSession
// ---------------------------------------------------------------------------

/**
 * Project a nested agent-canonical `Session` into agentmine's flat
 * `CanonicalSession`. The `cli` field (CliKind) maps to `source`; the
 * `transcript` sub-object is hoisted to the top level; `schemaVersion`
 * discriminants are dropped. Only defined optionals are set.
 */
export function flattenSession(s: Session): CanonicalSession {
  const t = s.transcript;

  const flat: CanonicalSession = {
    id: s.id,
    // cli (CliKind) maps to the string source agentmine uses for routing.
    source: s.cli,
    messages: t.messages,
    contentHash: t.contentHash,
  };

  // Session-level optionals
  if (s.externalId !== undefined) flat.externalId = s.externalId;
  if (s.url !== undefined) flat.url = s.url;
  if (s.parentSessionId !== undefined) flat.parentSessionId = s.parentSessionId;
  if (s.agentType !== undefined) flat.agentType = s.agentType;
  if (s.projectPath !== undefined) flat.projectPath = s.projectPath;
  if (s.gitBranch !== undefined) flat.gitBranch = s.gitBranch;
  if (s.model !== undefined) flat.model = s.model;
  if (s.title !== undefined) flat.title = s.title;
  if (s.author !== undefined) flat.author = s.author;
  if (s.status !== undefined) flat.status = s.status;
  if (s.startedAt !== undefined) flat.startedAt = s.startedAt;
  if (s.endedAt !== undefined) flat.endedAt = s.endedAt;

  // Transcript-level hoisted optionals
  if (t.rawPath !== undefined) flat.rawPath = t.rawPath;
  if (t.rawEvents !== undefined) flat.rawEvents = t.rawEvents;
  if (t.messageParts !== undefined) flat.messageParts = t.messageParts;
  if (t.inputTokens !== undefined) flat.inputTokens = t.inputTokens;
  if (t.outputTokens !== undefined) flat.outputTokens = t.outputTokens;
  if (t.cacheReadTokens !== undefined) flat.cacheReadTokens = t.cacheReadTokens;
  if (t.cacheCreationTokens !== undefined)
    flat.cacheCreationTokens = t.cacheCreationTokens;
  if (t.reasoningTokens !== undefined) flat.reasoningTokens = t.reasoningTokens;
  if (t.abortedTurns !== undefined) flat.abortedTurns = t.abortedTurns;
  if (t.redactionCount !== undefined) flat.redactionCount = t.redactionCount;

  return flat;
}

// ---------------------------------------------------------------------------
// AdapterOptions / CursorAdapterOptions — re-declared with legacy signatures
// ---------------------------------------------------------------------------

/** Legacy option bag for parseClaudeCodeFile. */
export interface AdapterOptions {
  /** Vestigial: was used to hash the canonical form. Ignored. */
  computeHash?: boolean;
  /** Override the `source` field on the returned session (default: "claude-code"). */
  source?: string;
  /** Override the session ID prefix (default: "cc"). */
  idPrefix?: string;
}

/** Legacy option bag for parseCursorFile. */
export interface CursorAdapterOptions {
  /** If set, the produced session is marked as a child of this id. */
  parentSessionId?: string;
  /** Override the project path (otherwise derived from filePath). */
  projectPath?: string;
}

// ---------------------------------------------------------------------------
// Compat wrappers
// ---------------------------------------------------------------------------

export async function parseClaudeCodeFile(
  filePath: string,
  opts: AdapterOptions = {},
): Promise<CanonicalSession | null> {
  const ccOpts: ClaudeCodeParseOptions = {};
  if (opts.idPrefix !== undefined) ccOpts.idPrefix = opts.idPrefix;

  const result = await parseClaudeCodeSessionFile(filePath, ccOpts);
  if (!result.success) return null;

  const flat = flattenSession(result.data);
  // Legacy: callers may override `source` (e.g. "cursor-agent-file").
  if (opts.source !== undefined) flat.source = opts.source;
  return flat;
}

export async function parseCursorFile(
  filePath: string,
  opts: CursorAdapterOptions = {},
): Promise<CanonicalSession | null> {
  const cxOpts: CursorParseOptions = {};
  if (opts.parentSessionId !== undefined)
    cxOpts.parentSessionId = opts.parentSessionId;
  if (opts.projectPath !== undefined) cxOpts.projectPath = opts.projectPath;

  const result = await parseCursorSessionFile(filePath, cxOpts);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export async function parseOpencodeSession(
  sessionFilePath: string,
  opts: OpencodeParseOptions = {},
): Promise<CanonicalSession | null> {
  const result = await parseOpencodeSessionFile(sessionFilePath, opts);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export function parseOpencodeSessionFromDb(
  db: OpencodeDb,
  sessionId: string,
  rawPath: string,
): CanonicalSession | null {
  const result = parseSessionFromDb(db, sessionId, rawPath);
  if (!result.success) return null;
  const flat = flattenSession(result.data);
  // opencode-db rows must keep source "opencode" (same as file-based rows).
  flat.source = "opencode";
  return flat;
}

export function listOpencodeSessionIds(db: OpencodeDb): string[] {
  return listSessionIds(db);
}

/**
 * Kilo Code reuses opencode's SQLite storage engine (`session`/`message`/`part`
 * tables in `kilo.db`); the shared parser stamps `cli:"kilo"`, so the flattened
 * source is already "kilo" — no override needed.
 */
export function parseKiloSessionFromDb(
  db: KiloDb,
  sessionId: string,
  rawPath: string,
): CanonicalSession | null {
  const result = parseKiloDbSession(db, sessionId, rawPath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export function listKiloSessionIds(db: KiloDb): string[] {
  return listKiloDbSessionIds(db);
}

/**
 * Goose stores every session in one global `sessions.db` (SQLite, WAL). The
 * shared parser stamps `cli:"goose"`, so the flattened source is already
 * "goose" — no override needed.
 */
export function parseGooseSessionFromDb(
  db: GooseDb,
  sessionId: string,
  rawPath: string,
): CanonicalSession | null {
  const result = parseGooseDbSession(db, sessionId, rawPath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export function listGooseSessionIds(db: GooseDb): string[] {
  return listGooseDbSessionIds(db);
}

export async function parseCodexFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseCodexSessionFile(filePath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export async function parseGeminiFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseGeminiSessionFile(filePath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

export async function parseQwenFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseQwenSessionFile(filePath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

/**
 * Cline writes each session as a directory with a `<id>.messages.json` payload
 * and an optional sibling `<id>.json` metadata file; `filePath` is the messages
 * file. The shared parser stamps `cli:"cline"`, so the flattened source is
 * already "cline" — no override needed.
 */
export async function parseClineFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseClineSessionFile(filePath);
  if (!result.success) return null;
  const session = flattenSession(result.data);
  const metadataRaw = session.rawEvents?.find(
    (event) => event.eventType === "session",
  )?.rawJson;
  const hash = createHash("sha256")
    .update("agentmine:cline-artifacts:v1\0")
    .update(session.contentHash)
    .update(
      metadataRaw === undefined
        ? "\0metadata:missing"
        : `\0metadata:present\0${metadataRaw}`,
    )
    .digest("hex");

  // agent-canonical hashes the normalized transcript. Agentmine also caches
  // session-level metadata and its raw event, so include the parser's exact
  // metadata snapshot in the effective ingest hash. This keeps the shared
  // parser authoritative and avoids rereading a sibling that could change
  // between parse and cache-key calculation.
  return { ...session, contentHash: hash };
}

/**
 * GitHub Copilot CLI writes each session as a directory
 * `~/.copilot/session-state/<uuid>/`; `filePath` is that dir's `events.jsonl`
 * (the lossless typed event stream). It is self-sufficient — no sibling
 * metadata file — so the flattened session needs no extra cache-key mixing. The
 * shared parser stamps `cli:"copilot"`, so the flattened source is already
 * "copilot" — no override needed.
 */
export async function parseCopilotFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseCopilotSessionFile(filePath);
  if (!result.success) return null;
  return flattenSession(result.data);
}
