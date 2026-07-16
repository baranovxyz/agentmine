import { z } from "zod";

/**
 * Canonical shape produced by every adapter. Downstream (DB writer, extractors,
 * queries) only sees this; per-source quirks live inside adapters.
 */

export const ToolCallSchema = z.object({
  name: z.string(),
  args: z.unknown().optional(),
  argsHash: z.string(),
  argsPreview: z.string(),
  outputPreview: z.string().optional(),
  outputFull: z.string().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  outputSha: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** ID used by the source to pair tool_use with tool_result (e.g. CC toolUseID). */
  callId: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const RawEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  eventType: z.string().optional(),
  ts: z.number().int().nonnegative().optional(),
  rawJson: z.string(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const MessagePartSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  partIdx: z.number().int().nonnegative(),
  turn: z.number().int().positive().optional(),
  role: z.string(),
  partType: z.string(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolCallIdx: z.number().int().nonnegative().optional(),
  payloadJson: z.string(),
  includedInMessageText: z.boolean().default(false),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const RoleSchema = z.enum([
  "user",
  "assistant",
  // Assistant reasoning blocks (Claude extended thinking, Codex reasoning_text)
  // emitted as their own messages so viewers can fold/expand them independently.
  "thinking",
  "system",
  "subagent",
]);
export type CanonicalRole = z.infer<typeof RoleSchema>;

export const SessionStatusSchema = z.enum([
  "running",
  "idle",
  "awaiting",
  "complete",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Per-message token usage. Same accounting as the session-level totals, but
 * attributed to a single message so spans (e.g. a skill invocation to the next
 * user turn) can be summed. Every field optional: only assistant messages from
 * sources that expose per-message usage (claude-code, opencode) carry it;
 * user/thinking messages and usage-blind sources (codex snapshot-only, cursor)
 * leave it undefined. Mirrors `SessionSchema`'s token fields.
 */
export const MessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

export const MessageSchema = z.object({
  turn: z.number().int().positive(),
  role: RoleSchema,
  author: z.string().optional(),
  /** Unix seconds. */
  ts: z.number().int().nonnegative().optional(),
  text: z.string(),
  toolCalls: z.array(ToolCallSchema).default([]),
  /** Per-message token usage where the source exposes it. See MessageUsageSchema. */
  usage: MessageUsageSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
  parentSessionId: z.string().optional(),
  agentType: z.string().optional(),
  projectPath: z.string().optional(),
  gitBranch: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  status: SessionStatusSchema.optional(),
  /** Unix seconds. */
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  messages: z.array(MessageSchema).default([]),
  contentHash: z.string(),
  rawPath: z.string().optional(),
  rawEvents: z.array(RawEventSchema).optional(),
  messageParts: z.array(MessagePartSchema).optional(),
  /** Number of redactions applied to this session's text fields (post-adapter). */
  redactionCount: z.number().int().nonnegative().optional(),
  /**
   * Cumulative token usage across the session. All fields optional because
   * not every source emits every breakdown (codex tracks reasoning_tokens;
   * Anthropic tracks cache_read/cache_creation; opencode emits both).
   */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Count of turns the user explicitly aborted (esc / cancel / interrupt). */
  abortedTurns: z.number().int().nonnegative().optional(),
});
export type CanonicalSession = z.infer<typeof SessionSchema>;
