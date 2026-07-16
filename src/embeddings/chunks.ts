import { createHash } from "node:crypto";
import type {
  CanonicalRole,
  CanonicalSession,
  Message,
} from "../adapters/types.js";
import { redactText } from "../redact/index.js";

export const CHUNKER_VERSION = "message-window-v2";
export const REDACTION_VERSION = "embed-redact-v1";
export const TEXT_PREVIEW_MAX = 240;

export interface EmbeddingChunk {
  sessionId: string;
  startTurn: number;
  endTurn: number;
  chunkIndex: number;
  sourceKind: "session" | "tool_summary" | "mixed";
  roleMix: string;
  chunkerVersion: string;
  redactionVersion: string;
  contentHash: string;
  tokenEstimate: number;
  charCount: number;
  textPreview: string;
  retrievalText: string;
}

export interface SkippedEmbeddingChunk {
  sessionId: string;
  startTurn: number;
  endTurn: number;
  chunkIndex: number;
  reason: "high_confidence_secret" | "empty_after_redaction";
}

export interface ChunkBuildOptions {
  targetTokens?: number;
  maxTokens?: number;
}

export interface ChunkBuildResult {
  chunks: EmbeddingChunk[];
  skippedChunks: SkippedEmbeddingChunk[];
  skippedSecretChunks: number;
  estimatedTokens: number;
}

interface PendingChunk {
  startTurn: number;
  endTurn: number;
  parts: string[];
  roles: Set<CanonicalRole>;
  hasToolSummary: boolean;
}

const DEFAULT_TARGET_TOKENS = 1_000;
const DEFAULT_MAX_TOKENS = 1_500;
const HIGH_CONFIDENCE_SECRET_RE =
  /\[REDACTED:(pem-private-key|anthropic-or-openai-key|github-token|aws-access-key-id|slack-token|bearer-token|yandex-oauth|env-value)\]/;

export function buildEmbeddingChunks(
  session: CanonicalSession,
  opts: ChunkBuildOptions = {},
): ChunkBuildResult {
  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const chunks: EmbeddingChunk[] = [];
  const skippedChunks: SkippedEmbeddingChunk[] = [];

  let pending: PendingChunk | null = null;
  let nextIndex = 0;

  const flush = () => {
    if (!pending) return;
    const rawText = pending.parts.join("\n\n").trim();
    const redacted = redactText(rawText);
    const retrievalText = normalizeForEmbedding(redacted.text);
    const tokenEstimate = estimateTokens(retrievalText);
    const skippedBase = {
      sessionId: session.id,
      startTurn: pending.startTurn,
      endTurn: pending.endTurn,
      chunkIndex: nextIndex,
    };

    if (!retrievalText) {
      skippedChunks.push({ ...skippedBase, reason: "empty_after_redaction" });
      nextIndex += 1;
      pending = null;
      return;
    }
    if (HIGH_CONFIDENCE_SECRET_RE.test(redacted.text)) {
      skippedChunks.push({ ...skippedBase, reason: "high_confidence_secret" });
      nextIndex += 1;
      pending = null;
      return;
    }

    const roles = [...pending.roles].sort();
    const sourceKind =
      pending.hasToolSummary &&
      pending.parts.some((part) => !part.startsWith("tool: "))
        ? "mixed"
        : pending.hasToolSummary
          ? "tool_summary"
          : "session";
    chunks.push({
      ...skippedBase,
      sourceKind,
      roleMix: roles.join(","),
      chunkerVersion: CHUNKER_VERSION,
      redactionVersion: REDACTION_VERSION,
      contentHash: sha256(
        `${REDACTION_VERSION}\n${CHUNKER_VERSION}\n${retrievalText}`,
      ),
      tokenEstimate,
      charCount: retrievalText.length,
      textPreview: retrievalText.slice(0, TEXT_PREVIEW_MAX),
      retrievalText,
    });
    nextIndex += 1;
    pending = null;
  };

  const addSegment = (message: Message, text: string) => {
    const segmentTokens = estimateTokens(text);
    if (!pending) {
      pending = newPending(message, text);
      if (segmentTokens >= maxTokens) flush();
      return;
    }
    const nextTokens = estimateTokens([...pending.parts, text].join("\n\n"));
    if (
      estimateTokens(pending.parts.join("\n\n")) >= targetTokens ||
      nextTokens > maxTokens
    ) {
      flush();
      pending = newPending(message, text);
      if (segmentTokens >= maxTokens) flush();
    } else {
      pending.parts.push(text);
      pending.endTurn = message.turn;
      pending.roles.add(message.role);
      pending.hasToolSummary ||= message.toolCalls.length > 0;
    }
  };

  for (const message of session.messages.sort((a, b) => a.turn - b.turn)) {
    const text = messageToEmbeddingText(message);
    if (!text) continue;
    // A single message can blow past the embedding model's context window
    // (giant tool outputs, pasted logs). Split it into <=maxTokens segments
    // so every emitted chunk stays embeddable instead of failing at the
    // provider with "input length exceeds the context length".
    for (const segment of splitToBudget(text, maxTokens))
      addSegment(message, segment);
  }
  flush();

  return {
    chunks,
    skippedChunks,
    skippedSecretChunks: skippedChunks.filter(
      (chunk) => chunk.reason === "high_confidence_secret",
    ).length,
    estimatedTokens: chunks.reduce(
      (sum, chunk) => sum + chunk.tokenEstimate,
      0,
    ),
  };
}

function newPending(message: Message, text: string): PendingChunk {
  return {
    startTurn: message.turn,
    endTurn: message.turn,
    parts: [text],
    roles: new Set([message.role]),
    hasToolSummary: message.toolCalls.length > 0,
  };
}

function messageToEmbeddingText(message: Message): string {
  const parts: string[] = [];
  const text = message.text.trim();
  if (text) parts.push(`${message.role}: ${text}`);
  for (const toolCall of message.toolCalls) {
    const bits = [`tool: ${toolCall.name}`];
    const command = extractCommand(toolCall.args);
    if (command) bits.push(`command: ${command}`);
    if (toolCall.exitCode !== undefined)
      bits.push(`exit: ${toolCall.exitCode}`);
    if (toolCall.argsPreview && !command)
      bits.push(`args: ${toolCall.argsPreview.slice(0, 200)}`);
    parts.push(bits.join(", "));
  }
  return parts.join("\n");
}

function extractCommand(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const command = record["command"] ?? record["cmd"];
  return typeof command === "string" ? command.slice(0, 300) : null;
}

function normalizeForEmbedding(text: string): string {
  return text
    .replace(/[A-Za-z0-9+/=]{200,}/g, "[BLOB:base64-like]")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Break `text` into segments that each estimate to <= `maxTokens`, preferring
 * line boundaries and hard-slicing any single line that is itself over budget.
 * Returns `[text]` unchanged when it already fits. Keeps every embedding chunk
 * inside the provider's context window (estimateTokens uses 4 chars/token, so
 * the char budget is `maxTokens * 4`).
 */
export function splitToBudget(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];
  const maxChars = Math.max(1, maxTokens * 4);
  const segments: string[] = [];
  let buf = "";
  const flushBuf = () => {
    if (buf) {
      segments.push(buf);
      buf = "";
    }
  };
  for (const line of text.split("\n")) {
    if (line.length > maxChars) {
      flushBuf();
      for (let i = 0; i < line.length; i += maxChars)
        segments.push(line.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + line.length + 1 > maxChars) flushBuf();
    buf = buf ? `${buf}\n${line}` : line;
  }
  flushBuf();
  return segments.length ? segments : [text];
}

export function serializeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deserializeVector(blob: Buffer): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    Math.floor(blob.byteLength / 4),
  );
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
