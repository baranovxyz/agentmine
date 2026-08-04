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
import { parseSessionFile as parseDroidSessionFile } from "agent-canonical/parsers/droid";
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
import { parseSessionFile as parsePiSessionFile } from "agent-canonical/parsers/pi";
import { parseSessionFile as parseQwenSessionFile } from "agent-canonical/parsers/qwen";
import { parseSessionFile as parseVibeSessionFile } from "agent-canonical/parsers/vibe";
import type { Session } from "agent-canonical/schemas";
import { type CanonicalSession, SessionSchema } from "./types.js";

const CanonicalTokenUsageSchema = SessionSchema.pick({
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheCreationTokens: true,
  reasoningTokens: true,
});

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

  CanonicalTokenUsageSchema.parse(flat);
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

/**
 * Pi writes one append-only JSONL per session at
 * `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuidv7>.jsonl`; `filePath`
 * is that file. Like Copilot it is self-sufficient — every session-level fact
 * lives on a line of the same file — so the flattened session needs no extra
 * cache-key mixing. The shared parser stamps `cli:"pi"`, so the flattened
 * source is already "pi" — no override needed.
 */
export async function parsePiFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parsePiSessionFile(filePath);
  if (!result.success) return null;
  return flattenSession(result.data);
}

/**
 * Factory Droid writes each session as `<uuid>.jsonl` plus a sibling
 * `<uuid>.settings.json` under `~/.factory/sessions/<cwd-slug>/`; `filePath` is
 * the JSONL and the parser discovers the settings file itself. The settings
 * sibling is the only source of the model alias and the session token totals,
 * so it joins the effective ingest hash (see `mixSidecarIntoCacheKey`). The
 * shared parser stamps `cli:"droid"`, so the flattened source is already
 * "droid" — no override needed.
 */
export async function parseDroidFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseDroidSessionFile(filePath);
  if (!result.success) return null;
  return mixSidecarIntoCacheKey(
    flattenSession(result.data),
    "agentmine:droid-settings:v1",
  );
}

/**
 * Mistral Vibe writes each session as a directory under `~/.vibe/logs/session/`
 * holding `messages.jsonl` and a `meta.json` sidecar; `filePath` is the
 * `messages.jsonl` (the parser also accepts the directory). `meta.json` is the
 * only source of identity, timing, project path, model, and token totals, so it
 * joins the effective ingest hash (see `mixSidecarIntoCacheKey`). The shared
 * parser stamps `cli:"vibe"`, so the flattened source is already "vibe" — no
 * override needed.
 */
export async function parseVibeFile(
  filePath: string,
): Promise<CanonicalSession | null> {
  const result = await parseVibeSessionFile(filePath);
  if (!result.success) return null;
  return mixSidecarIntoCacheKey(
    flattenSession(result.data),
    "agentmine:vibe-meta:v1",
  );
}

/**
 * Fold a session's sidecar-derived facts into its ingest cache key.
 *
 * agent-canonical hashes the normalized transcript only, which is the right
 * identity for a transcript. Droid and Vibe, though, keep session-level facts
 * (model, token totals, timing, title) in a sibling file that is rewritten
 * after the transcript — and unlike Cline's metadata, neither parser emits that
 * sibling as a raw event, so there is no raw blob to mix. Hashing the
 * sidecar-derived fields off the already-parsed session keeps the shared parser
 * authoritative, needs no second read, and stops a sidecar-only update from
 * being skipped as "up to date" with stale usage.
 */
function mixSidecarIntoCacheKey(
  session: CanonicalSession,
  domain: string,
): CanonicalSession {
  const sidecarFacts = JSON.stringify([
    session.model ?? null,
    session.title ?? null,
    session.projectPath ?? null,
    session.gitBranch ?? null,
    session.parentSessionId ?? null,
    session.status ?? null,
    session.startedAt ?? null,
    session.endedAt ?? null,
    session.inputTokens ?? null,
    session.outputTokens ?? null,
    session.cacheReadTokens ?? null,
    session.cacheCreationTokens ?? null,
    session.reasoningTokens ?? null,
  ]);
  const contentHash = createHash("sha256")
    .update(`${domain}\0`)
    .update(session.contentHash)
    .update("\0")
    .update(sidecarFacts)
    .digest("hex");
  return { ...session, contentHash };
}
