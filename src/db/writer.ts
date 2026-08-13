import type { CanonicalSession } from "../adapters/types.js";
import { extractListingsFromRaw } from "../extract/skillListingFromRaw.js";
import { archiveAlias, attachArchive } from "./archives.js";
import type { DatabaseType } from "./client.js";
import { encodePayload } from "./payloadCodec.js";

/**
 * Write one session's cold payload into the attached archives.
 *
 * MUST be called, and committed, BEFORE `upsertSession` writes the hot rows
 * that reference this payload. A transaction spanning attached databases is
 * not atomic under WAL, so ordering — not a shared transaction — is what
 * guarantees a hot row never outlives its payload. An interrupted run may
 * leave archive rows with no hot rows; that orphan state is valid and is
 * overwritten idempotently the next time the session is normalized.
 *
 * Call inside a transaction covering the archives only.
 */
export function writeSessionPayload(
  db: DatabaseType,
  session: CanonicalSession,
): void {
  const raw = archiveAlias("raw");
  const tools = archiveAlias("tools");

  deleteSessionPayload(db, session.id);

  const insertRawEvent = db.prepare(
    `INSERT INTO ${raw}.raw_events (session_id, seq, source, event_type, ts, payload)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const ev of session.rawEvents ?? []) {
    insertRawEvent.run(
      session.id,
      ev.seq,
      session.source,
      ev.eventType ?? null,
      ev.ts ?? null,
      encodePayload(ev.rawJson),
    );
  }

  const insertToolOutput = db.prepare(
    `INSERT INTO ${tools}.tool_outputs (session_id, turn, idx, payload)
     VALUES (?, ?, ?, ?)`,
  );
  for (const msg of session.messages) {
    msg.toolCalls.forEach((tc, idx) => {
      if (tc.outputFull === undefined) return;
      insertToolOutput.run(
        session.id,
        msg.turn,
        idx,
        encodePayload(tc.outputFull),
      );
    });
  }
}

/**
 * Write one session completely, payload first, in two separate transactions.
 *
 * For callers that handle a single session at a time. Batch callers such as
 * `normalize` should drive `writeSessionPayload` and `upsertSession` directly
 * so one payload transaction and one hot transaction cover the whole batch.
 *
 * Attaches (and creates) the archives if the caller has not already.
 */
export function upsertSessionWithPayload(
  db: DatabaseType,
  session: CanonicalSession,
): void {
  attachArchive(db, "raw", { create: true });
  attachArchive(db, "tools", { create: true });
  db.transaction(() => {
    writeSessionPayload(db, session);
  })();
  db.transaction(() => {
    upsertSession(db, session);
  })();
}

/** Remove one session's archived payload. Requires both archives attached. */
export function deleteSessionPayload(
  db: DatabaseType,
  sessionId: string,
): void {
  db.prepare(
    `DELETE FROM ${archiveAlias("raw")}.raw_events WHERE session_id = ?`,
  ).run(sessionId);
  db.prepare(
    `DELETE FROM ${archiveAlias("tools")}.tool_outputs WHERE session_id = ?`,
  ).run(sessionId);
}

/** How many payload rows a session contributes to each archive. */
export function payloadCounts(session: CanonicalSession): {
  rawEvents: number;
  toolOutputs: number;
} {
  let toolOutputs = 0;
  for (const msg of session.messages) {
    for (const tc of msg.toolCalls) {
      if (tc.outputFull !== undefined) toolOutputs += 1;
    }
  }
  return { rawEvents: (session.rawEvents ?? []).length, toolOutputs };
}

/**
 * Idempotent writer: delete-then-insert on session_id for every table we own.
 * Call inside a transaction. Caller is responsible for wrapping many sessions
 * in one transaction for performance.
 *
 * Writes hot rows only. Cold payload is written separately and earlier by
 * `writeSessionPayload`.
 */
export function upsertSession(
  db: DatabaseType,
  session: CanonicalSession,
): void {
  deleteSession(db, session.id);

  const counts = payloadCounts(session);
  const userTurns = session.messages.filter((m) => m.role === "user").length;
  const asstTurns = session.messages.filter(
    (m) => m.role === "assistant",
  ).length;
  let toolCallCount = 0;
  let toolErrorCount = 0;
  for (const m of session.messages) {
    toolCallCount += m.toolCalls.length;
    for (const tc of m.toolCalls)
      if (tc.exitCode !== undefined && tc.exitCode !== 0) toolErrorCount += 1;
  }

  const firstUser =
    session.messages.find((m) => m.role === "user")?.text?.slice(0, 500) ??
    null;
  const lastUser =
    [...session.messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.text?.slice(0, 500) ?? null;

  const duration =
    session.startedAt !== undefined && session.endedAt !== undefined
      ? session.endedAt - session.startedAt
      : null;

  db.prepare(
    `INSERT INTO sessions (
      id, source, external_id, url, parent_session_id, project_path, git_branch, model,
      title, author, status, started_at, ended_at, duration_s,
      turn_count, user_turn_count, assistant_turn_count,
      tool_call_count, tool_error_count,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens,
      aborted_turns,
      first_user_prompt, last_user_prompt,
      has_subagents, subagent_count, ended_with_commit, ended_with_commit_attempted, agent_type,
      content_hash, redaction_count, raw_path,
      raw_event_count, tool_output_count
    ) VALUES (
      @id, @source, @external_id, @url, @parent_session_id, @project_path, @git_branch, @model,
      @title, @author, @status, @started_at, @ended_at, @duration_s,
      @turn_count, @user_turn_count, @assistant_turn_count,
      @tool_call_count, @tool_error_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @reasoning_tokens,
      @aborted_turns,
      @first_user_prompt, @last_user_prompt,
      @has_subagents, @subagent_count, @ended_with_commit, @ended_with_commit_attempted, @agent_type,
      @content_hash, @redaction_count, @raw_path,
      @raw_event_count, @tool_output_count
    )`,
  ).run({
    id: session.id,
    source: session.source,
    external_id: session.externalId ?? null,
    url: session.url ?? null,
    parent_session_id: session.parentSessionId ?? null,
    project_path: session.projectPath ?? null,
    git_branch: session.gitBranch ?? null,
    model: session.model ?? null,
    title: session.title ?? null,
    author: session.author ?? null,
    status: session.status ?? null,
    started_at: session.startedAt ?? null,
    ended_at: session.endedAt ?? null,
    duration_s: duration,
    turn_count: session.messages.length,
    user_turn_count: userTurns,
    assistant_turn_count: asstTurns,
    tool_call_count: toolCallCount,
    tool_error_count: toolErrorCount,
    input_tokens: session.inputTokens ?? null,
    output_tokens: session.outputTokens ?? null,
    cache_read_tokens: session.cacheReadTokens ?? null,
    cache_creation_tokens: session.cacheCreationTokens ?? null,
    reasoning_tokens: session.reasoningTokens ?? null,
    aborted_turns: session.abortedTurns ?? 0,
    first_user_prompt: firstUser,
    last_user_prompt: lastUser,
    has_subagents: 0,
    subagent_count: 0,
    ended_with_commit: 0,
    ended_with_commit_attempted: 0,
    agent_type: session.agentType ?? null,
    content_hash: session.contentHash,
    redaction_count: session.redactionCount ?? 0,
    raw_path: session.rawPath ?? null,
    // Payload lives in the archives; these counts let `stats` report corpus
    // totals without attaching or walking an archive index.
    raw_event_count: counts.rawEvents,
    tool_output_count: counts.toolOutputs,
  });

  const insertMsg = db.prepare(
    `INSERT INTO messages (
      session_id, turn, role, author, ts, text,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, reasoning_tokens
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO messages_fts (session_id, turn, text) VALUES (?, ?, ?)`,
  );
  const insertTc = db.prepare(
    `INSERT INTO tool_calls (
      session_id, turn, idx, name, args_hash, args_preview, args_json,
      output_preview, output_bytes, output_sha, exit_code, duration_ms, call_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessagePart = db.prepare(
    `INSERT INTO message_parts (
      session_id, source_seq, part_idx, turn, role, part_type, text, tool_name,
      tool_call_idx, payload_json, included_in_message_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Skill listings are recovered here, while the parsed events are already in
  // memory, rather than by re-scanning archived payload during extraction.
  // That removes the last cross-session reader of raw payload.
  writeSkillsAvailable(db, session);

  for (const part of session.messageParts ?? []) {
    insertMessagePart.run(
      session.id,
      part.sourceSeq,
      part.partIdx,
      part.turn ?? null,
      part.role,
      part.partType,
      part.text ?? null,
      part.toolName ?? null,
      part.toolCallIdx ?? null,
      part.payloadJson,
      part.includedInMessageText ? 1 : 0,
    );
  }

  for (const msg of session.messages) {
    insertMsg.run(
      session.id,
      msg.turn,
      msg.role,
      msg.author ?? null,
      msg.ts ?? null,
      msg.text,
      msg.usage?.inputTokens ?? null,
      msg.usage?.outputTokens ?? null,
      msg.usage?.cacheReadTokens ?? null,
      msg.usage?.cacheCreationTokens ?? null,
      msg.usage?.reasoningTokens ?? null,
    );
    insertFts.run(session.id, msg.turn, msg.text);

    msg.toolCalls.forEach((tc, idx) => {
      insertTc.run(
        session.id,
        msg.turn,
        idx,
        tc.name,
        tc.argsHash,
        tc.argsPreview,
        tc.args !== undefined ? JSON.stringify(tc.args) : null,
        tc.outputPreview ?? null,
        tc.outputBytes ?? null,
        tc.outputSha ?? null,
        tc.exitCode ?? null,
        tc.durationMs ?? null,
        tc.callId ?? null,
      );
    });
  }

  // Mark this session for incremental `extract`. The insert shares the caller's
  // per-batch transaction, so a session becomes extract-dirty atomically with
  // its canonical rows.
  markSessionDirty(db, session.id);
}

/**
 * Populate `skills_available` from the session's in-memory raw events.
 *
 * Previously derived by `extract` scanning every stored raw event, including
 * an unindexed substring match across the whole payload table. Payload is now
 * archived and compressed, so recovery happens here at parse time instead.
 * Same union semantics as before: the latest listing wins.
 */
function writeSkillsAvailable(
  db: DatabaseType,
  session: CanonicalSession,
): void {
  // Only Claude Code emits skill listings; the previous extractor filtered on
  // `source = 'claude-code'` in SQL and that filter is preserved here.
  if (session.source !== "claude-code") return;
  const events = session.rawEvents ?? [];
  if (events.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO skills_available
       (session_id, skill_name, description, origin, source_seq, is_initial)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, skill_name) DO UPDATE SET
       description = excluded.description,
       origin = excluded.origin,
       source_seq = excluded.source_seq,
       is_initial = excluded.is_initial`,
  );

  // Ascending seq so the latest listing wins on conflict.
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    for (const listing of extractListingsFromRaw(ev.rawJson, ev.eventType)) {
      for (const skill of listing.skills) {
        insert.run(
          session.id,
          skill.skillName,
          skill.description,
          skill.origin,
          ev.seq,
          listing.isInitial ? 1 : 0,
        );
      }
    }
  }
}

/** Flag one session as needing (re)extraction. */
export function markSessionDirty(db: DatabaseType, sessionId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO dirty_sessions (session_id) VALUES (?)`,
  ).run(sessionId);
}

/** The session ids awaiting extraction, oldest-insert first. */
export function getDirtySessions(db: DatabaseType): string[] {
  return db
    .prepare<[], { session_id: string }>(
      `SELECT session_id FROM dirty_sessions`,
    )
    .all()
    .map((r) => r.session_id);
}

/** Clear the given session ids from the dirty set (post-extract). */
export function clearDirtySessions(
  db: DatabaseType,
  ids: readonly string[],
): void {
  const del = db.prepare(`DELETE FROM dirty_sessions WHERE session_id = ?`);
  const tx = db.transaction(() => {
    for (const id of ids) del.run(id);
  });
  tx();
}

/** Empty the dirty set entirely (after a full rebuild). */
export function clearAllDirtySessions(db: DatabaseType): void {
  db.prepare(`DELETE FROM dirty_sessions`).run();
}

export interface FileStat {
  mtimeMs: number;
  size: number;
}

/** The `(mtime, size)` of every source file recorded on a prior normalize. */
export function loadFileStatCache(db: DatabaseType): Map<string, FileStat> {
  const rows = db
    .prepare<[], { path: string; mtime_ms: number; size: number }>(
      `SELECT path, mtime_ms, size FROM file_stat_cache`,
    )
    .all();
  const map = new Map<string, FileStat>();
  for (const r of rows) map.set(r.path, { mtimeMs: r.mtime_ms, size: r.size });
  return map;
}

/** Remember a file's `(mtime, size)` so an unchanged re-run can skip its parse. */
export function recordFileStat(
  db: DatabaseType,
  path: string,
  stat: FileStat,
): void {
  db.prepare(
    `INSERT INTO file_stat_cache (path, mtime_ms, size) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
  ).run(path, stat.mtimeMs, stat.size);
}

export function deleteSession(db: DatabaseType, sessionId: string): void {
  // Cold payload is NOT deleted here. Hot rows are removed first and archive
  // rows separately afterwards, so an interruption can only orphan payload —
  // never strand a hot row whose payload is already gone.
  db.prepare(`DELETE FROM message_parts WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM messages_fts WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM files_touched WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM shell_commands WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM user_corrections WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM tool_errors WHERE session_id = ?`).run(sessionId);
  // Extracted fact and pattern tables are cleared so a re-imported session's
  // stale facts do not survive.
  db.prepare(`DELETE FROM skills_invoked WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM skills_available WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM skills_hook_injected WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM mcp_calls WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM web_fetches WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM git_operations WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM todo_events WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM user_interruptions WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM friction_events WHERE session_id = ?`).run(sessionId);
  db.prepare(
    `DELETE FROM subagent_invocations WHERE parent_session_id = ?`,
  ).run(sessionId);
  db.prepare(`DELETE FROM self_resolutions WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM search_calls WHERE session_id = ?`).run(sessionId);
  db.prepare(
    `DELETE FROM embeddings
      WHERE chunk_id IN (SELECT id FROM embedding_chunks WHERE session_id = ?)`,
  ).run(sessionId);
  db.prepare(`DELETE FROM embedding_chunks WHERE session_id = ?`).run(
    sessionId,
  );
  db.prepare(`DELETE FROM dirty_sessions WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
}

export function sessionIsUpToDate(
  db: DatabaseType,
  sessionId: string,
  contentHash: string,
): boolean {
  const row = db
    .prepare<[string], { content_hash: string }>(
      `SELECT content_hash FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  return row?.content_hash === contentHash;
}

/** One journal event line, stored verbatim for a workflow run. */
export interface WorkflowJournalLineRaw {
  seq: number;
  agentId: string | null;
  eventType: string | null;
  key: string | null;
  rawJson: string;
}

/** Lossless raw inputs for one workflow run (manifest + its journal lines). */
export interface WorkflowRunRaw {
  runId: string;
  source: string;
  orchestratingExternalId: string | null;
  rawPath: string | null;
  contentHash: string;
  manifestJson: string;
  journalLines: WorkflowJournalLineRaw[];
}

/**
 * Idempotent raw-workflow writer: delete-then-insert on run_id across both raw
 * workflow tables. Call inside a transaction (the caller wraps a batch).
 */
export function upsertWorkflowRunRaw(
  db: DatabaseType,
  run: WorkflowRunRaw,
): void {
  db.prepare(`DELETE FROM raw_workflow_runs WHERE run_id = ?`).run(run.runId);
  db.prepare(`DELETE FROM raw_workflow_journal WHERE run_id = ?`).run(
    run.runId,
  );
  db.prepare(
    `INSERT INTO raw_workflow_runs
       (run_id, source, orchestrating_external_id, raw_path, content_hash, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    run.runId,
    run.source,
    run.orchestratingExternalId,
    run.rawPath,
    run.contentHash,
    run.manifestJson,
  );
  const insertLine = db.prepare(
    `INSERT INTO raw_workflow_journal (run_id, seq, agent_id, event_type, key, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const line of run.journalLines) {
    insertLine.run(
      run.runId,
      line.seq,
      line.agentId,
      line.eventType,
      line.key,
      line.rawJson,
    );
  }
}

export function workflowRunRawIsUpToDate(
  db: DatabaseType,
  runId: string,
  contentHash: string,
): boolean {
  const row = db
    .prepare<[string], { content_hash: string }>(
      `SELECT content_hash FROM raw_workflow_runs WHERE run_id = ?`,
    )
    .get(runId);
  return row?.content_hash === contentHash;
}
