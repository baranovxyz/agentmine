import type { CanonicalSession } from "../adapters/types.js";
import type { DatabaseType } from "./client.js";

/**
 * Idempotent writer: delete-then-insert on session_id for every table we own.
 * Call inside a transaction. Caller is responsible for wrapping many sessions
 * in one transaction for performance.
 */
export function upsertSession(
  db: DatabaseType,
  session: CanonicalSession,
): void {
  deleteSession(db, session.id);

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
      content_hash, redaction_count, raw_path
    ) VALUES (
      @id, @source, @external_id, @url, @parent_session_id, @project_path, @git_branch, @model,
      @title, @author, @status, @started_at, @ended_at, @duration_s,
      @turn_count, @user_turn_count, @assistant_turn_count,
      @tool_call_count, @tool_error_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @reasoning_tokens,
      @aborted_turns,
      @first_user_prompt, @last_user_prompt,
      @has_subagents, @subagent_count, @ended_with_commit, @ended_with_commit_attempted, @agent_type,
      @content_hash, @redaction_count, @raw_path
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
  const insertToolOutput = db.prepare(
    `INSERT INTO tool_outputs (session_id, turn, idx, output_text) VALUES (?, ?, ?, ?)`,
  );
  const insertRawEvent = db.prepare(
    `INSERT INTO raw_events (session_id, seq, source, event_type, ts, raw_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMessagePart = db.prepare(
    `INSERT INTO message_parts (
      session_id, source_seq, part_idx, turn, role, part_type, text, tool_name,
      tool_call_idx, payload_json, included_in_message_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const ev of session.rawEvents ?? []) {
    insertRawEvent.run(
      session.id,
      ev.seq,
      session.source,
      ev.eventType ?? null,
      ev.ts ?? null,
      ev.rawJson,
    );
  }

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
      if (tc.outputFull !== undefined) {
        insertToolOutput.run(session.id, msg.turn, idx, tc.outputFull);
      }
    });
  }
}

export function deleteSession(db: DatabaseType, sessionId: string): void {
  db.prepare(`DELETE FROM message_parts WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM raw_events WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM tool_outputs WHERE session_id = ?`).run(sessionId);
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
