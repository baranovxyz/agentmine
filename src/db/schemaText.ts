// Schema inlined so the bundled binary doesn't depend on schema.sql on disk.
// Keep in sync with src/db/schema.sql. The .sql file is the source of truth
// during development (IDE syntax highlighting, easy review); this string is
// a build-time copy.

export const SCHEMA_SQL = `
-- agentmine schema for local coding-agent session transcripts.
-- Tables below cover canonical sessions, messages, tool calls, extracted facts,
-- local embeddings, and model pricing.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- CORE ================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  parent_session_id TEXT,
  project_path TEXT,
  git_branch TEXT,
  model TEXT,
  title TEXT,
  author TEXT,
  status TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_s INTEGER,
  turn_count INTEGER,
  user_turn_count INTEGER,
  assistant_turn_count INTEGER,
  tool_call_count INTEGER,
  tool_error_count INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  reasoning_tokens INTEGER,
  aborted_turns INTEGER DEFAULT 0,
  first_user_prompt TEXT,
  last_user_prompt TEXT,
  has_subagents INTEGER,
  subagent_count INTEGER,
  ended_with_commit INTEGER,
  ended_with_commit_attempted INTEGER,
  agent_type TEXT,
  content_hash TEXT,
  redaction_count INTEGER,
  raw_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_source_started ON sessions(source, started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_external ON sessions(source, external_id);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  role TEXT NOT NULL,
  author TEXT,
  ts INTEGER,
  text TEXT,
  -- Per-message token usage (schema v11). NULL except on assistant messages
  -- from sources that expose per-message usage (claude-code, opencode).
  -- Mirrors the session-level token columns; lets a skill-invocation span be
  -- summed message-by-message. codex (snapshot-only) and cursor leave these NULL.
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  reasoning_tokens INTEGER,
  PRIMARY KEY(session_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  turn UNINDEXED,
  text,
  content='messages',
  content_rowid='rowid'
);

-- Session-only: agent tool invocations within a turn
CREATE TABLE IF NOT EXISTS tool_calls (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  args_hash TEXT,
  args_preview TEXT,
  args_json TEXT,           -- full JSON args used by extractors
  output_preview TEXT,
  output_bytes INTEGER,
  output_sha TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  call_id TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_tc_name ON tool_calls(name);
CREATE INDEX IF NOT EXISTS idx_tc_args_hash ON tool_calls(args_hash);
CREATE INDEX IF NOT EXISTS idx_tc_exit ON tool_calls(exit_code);

CREATE TABLE IF NOT EXISTS tool_outputs (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  output_text TEXT NOT NULL,
  PRIMARY KEY(session_id, turn, idx)
);

CREATE TABLE IF NOT EXISTS raw_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT,
  ts INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_raw_events_type ON raw_events(source, event_type);

CREATE TABLE IF NOT EXISTS message_parts (
  session_id TEXT NOT NULL,
  source_seq INTEGER NOT NULL,
  part_idx INTEGER NOT NULL,
  turn INTEGER,
  role TEXT NOT NULL,
  part_type TEXT NOT NULL,
  text TEXT,
  tool_name TEXT,
  tool_call_idx INTEGER,
  payload_json TEXT NOT NULL,
  included_in_message_text INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, source_seq, part_idx)
);
CREATE INDEX IF NOT EXISTS idx_message_parts_turn ON message_parts(session_id, turn);
CREATE INDEX IF NOT EXISTS idx_message_parts_type ON message_parts(part_type);
CREATE INDEX IF NOT EXISTS idx_message_parts_tool ON message_parts(tool_name);

-- FACT TABLES (populated by \`agentmine extract\`) ========================
CREATE TABLE IF NOT EXISTS files_touched (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  op TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes_changed INTEGER,
  PRIMARY KEY(session_id, turn, op, path)
);
CREATE INDEX IF NOT EXISTS idx_ft_path ON files_touched(path);
CREATE INDEX IF NOT EXISTS idx_ft_op ON files_touched(op);

CREATE TABLE IF NOT EXISTS shell_commands (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  cmd_head TEXT,
  cmd_full TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_sc_head ON shell_commands(cmd_head);
CREATE INDEX IF NOT EXISTS idx_sc_exit ON shell_commands(exit_code);

CREATE TABLE IF NOT EXISTS user_corrections (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL,
  text TEXT,
  preceding_turn INTEGER,
  preceding_tool_calls INTEGER,
  response_time_ms INTEGER,
  followed_by_revert INTEGER,
  source TEXT,
  project_path TEXT,
  -- LLM-classified root cause; null until classified. Preserved across re-extracts.
  kind_llm TEXT,
  kind_llm_source TEXT,
  PRIMARY KEY(session_id, turn)
);
CREATE INDEX IF NOT EXISTS idx_uc_kind ON user_corrections(kind);
CREATE INDEX IF NOT EXISTS idx_uc_kind_llm ON user_corrections(kind_llm);
CREATE INDEX IF NOT EXISTS idx_uc_source ON user_corrections(source);
CREATE INDEX IF NOT EXISTS idx_uc_project ON user_corrections(project_path);

CREATE TABLE IF NOT EXISTS tool_errors (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  tool_name TEXT,
  error_category TEXT,
  error_text TEXT,
  -- LLM-classified category; null until classified. Preserved across re-extracts.
  error_category_llm TEXT,
  error_category_llm_source TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_te_tool ON tool_errors(tool_name);
CREATE INDEX IF NOT EXISTS idx_te_cat ON tool_errors(error_category);
CREATE INDEX IF NOT EXISTS idx_te_cat_llm ON tool_errors(error_category_llm);

-- Extracted fact tables ===============================================
CREATE TABLE IF NOT EXISTS skills_invoked (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  skill_name TEXT NOT NULL,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_si_name ON skills_invoked(skill_name);

CREATE TABLE IF NOT EXISTS skills_available (
  session_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'unknown',
  source_seq INTEGER,
  is_initial INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, skill_name)
);
CREATE INDEX IF NOT EXISTS idx_sa_name ON skills_available(skill_name);
CREATE INDEX IF NOT EXISTS idx_sa_session ON skills_available(session_id);

CREATE TABLE IF NOT EXISTS skills_hook_injected (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  skill_slug TEXT NOT NULL,
  source_path TEXT,
  PRIMARY KEY(session_id, turn, skill_slug)
);
CREATE INDEX IF NOT EXISTS idx_shi_slug ON skills_hook_injected(skill_slug);

CREATE TABLE IF NOT EXISTS mcp_calls (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  server TEXT,
  tool TEXT,
  args_hash TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_mcp_server ON mcp_calls(server);
CREATE INDEX IF NOT EXISTS idx_mcp_tool ON mcp_calls(tool);

CREATE TABLE IF NOT EXISTS web_fetches (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  kind TEXT,
  url TEXT,
  domain TEXT,
  query TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_wf_domain ON web_fetches(domain);

CREATE TABLE IF NOT EXISTS git_operations (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  op TEXT NOT NULL,
  branch TEXT,
  commit_hash TEXT,
  exit_code INTEGER,
  cmd_full TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_git_op ON git_operations(op);

CREATE TABLE IF NOT EXISTS todo_events (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  total INTEGER,
  pending INTEGER,
  in_progress INTEGER,
  completed INTEGER,
  cancelled INTEGER,
  PRIMARY KEY(session_id, turn, idx)
);

CREATE TABLE IF NOT EXISTS user_interruptions (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  response_time_ms INTEGER,
  reason_hint TEXT,
  PRIMARY KEY(session_id, turn)
);

-- Extracted pattern tables ============================================
CREATE TABLE IF NOT EXISTS tool_call_ngrams (
  sequence TEXT NOT NULL,
  n INTEGER NOT NULL,
  count INTEGER NOT NULL,
  sessions INTEGER NOT NULL,
  example_session_id TEXT,
  example_start_turn INTEGER,
  PRIMARY KEY(sequence, n)
);
CREATE INDEX IF NOT EXISTS idx_ngram_n ON tool_call_ngrams(n);

CREATE TABLE IF NOT EXISTS prompt_templates (
  hash TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  count INTEGER NOT NULL,
  example_session_ids TEXT
);

CREATE TABLE IF NOT EXISTS friction_events (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  type TEXT NOT NULL,
  context TEXT,
  -- LLM-classified axis (e.g. agent intent at the friction). Preserved across re-extracts.
  type_llm TEXT,
  type_llm_source TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_fe_type ON friction_events(type);
CREATE INDEX IF NOT EXISTS idx_fe_type_llm ON friction_events(type_llm);

CREATE TABLE IF NOT EXISTS subagent_invocations (
  parent_session_id TEXT NOT NULL,
  parent_turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  child_session_id TEXT,
  subagent_type TEXT,
  task_text TEXT,
  PRIMARY KEY(parent_session_id, parent_turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_sub_type ON subagent_invocations(subagent_type);
CREATE INDEX IF NOT EXISTS idx_sub_child ON subagent_invocations(child_session_id);

-- Workspace lookups: grep / glob calls. One row per call.
-- \`tool\` is the canonical kind ('grep' | 'glob'); \`pattern\` is the
-- regex / glob string; \`path\` is the search root; \`include\` is an
-- optional file filter (Grep --include).
CREATE TABLE IF NOT EXISTS search_calls (
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  tool TEXT NOT NULL,
  pattern TEXT,
  path TEXT,
  include TEXT,
  PRIMARY KEY(session_id, turn, idx)
);
CREATE INDEX IF NOT EXISTS idx_search_tool ON search_calls(tool);
CREATE INDEX IF NOT EXISTS idx_search_pattern ON search_calls(pattern);

-- Self-resolutions: the same args_hash failed then succeeded with no user turn
-- in between. Captures intermediate tool calls and assistant reasoning for
-- identifying reusable recovery patterns.
CREATE TABLE IF NOT EXISTS self_resolutions (
  session_id TEXT NOT NULL,
  fail_turn INTEGER NOT NULL,
  ok_turn INTEGER NOT NULL,
  gap_turns INTEGER NOT NULL,
  tool_name TEXT,
  args_hash TEXT NOT NULL,
  args_preview TEXT,
  resolution_tool_calls_json TEXT,
  resolution_reasoning_json TEXT,
  PRIMARY KEY(session_id, fail_turn, args_hash)
);
CREATE INDEX IF NOT EXISTS idx_sr_tool ON self_resolutions(tool_name);
CREATE INDEX IF NOT EXISTS idx_sr_gap ON self_resolutions(gap_turns);

-- Local embeddings ====================================================
CREATE TABLE IF NOT EXISTS embedding_models (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, model, dimensions)
);

CREATE TABLE IF NOT EXISTS embedding_chunks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  start_turn INTEGER NOT NULL,
  end_turn INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  role_mix TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  redaction_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  text_preview TEXT,
  retrieval_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE(session_id, start_turn, end_turn, chunk_index, chunker_version, redaction_version, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_embedding_chunks_session ON embedding_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_embedding_chunks_hash ON embedding_chunks(content_hash);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  vector BLOB NOT NULL,
  vector_norm REAL NOT NULL,
  token_count INTEGER,
  embedded_at INTEGER NOT NULL,
  provider_request_id TEXT,
  PRIMARY KEY(chunk_id, model_id),
  FOREIGN KEY(chunk_id) REFERENCES embedding_chunks(id) ON DELETE CASCADE,
  FOREIGN KEY(model_id) REFERENCES embedding_models(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_embeddings_model_chunk ON embeddings(model_id, chunk_id);

CREATE TABLE IF NOT EXISTS embedding_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id INTEGER,
  status TEXT NOT NULL,
  requested_limit INTEGER,
  planned_chunks INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  embedded_chunks INTEGER NOT NULL DEFAULT 0,
  skipped_cached_chunks INTEGER NOT NULL DEFAULT 0,
  failed_chunks INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_json TEXT
);

-- META ================================================================
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- PRE-BAKED VIEWS =====================================================
CREATE VIEW IF NOT EXISTS v_sessions_by_month AS
  SELECT strftime('%Y-%m', started_at, 'unixepoch') AS month,
         source, COUNT(*) AS sessions
    FROM sessions GROUP BY month, source;

CREATE VIEW IF NOT EXISTS v_top_shell_heads AS
  SELECT cmd_head, COUNT(*) AS runs,
         SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) AS failures,
         COUNT(DISTINCT session_id) AS sessions
    FROM shell_commands GROUP BY cmd_head;

CREATE VIEW IF NOT EXISTS v_top_files AS
  SELECT path, COUNT(*) AS ops,
         SUM(CASE WHEN op = 'read' THEN 1 ELSE 0 END) AS reads,
         SUM(CASE WHEN op = 'edit' OR op = 'write' THEN 1 ELSE 0 END) AS writes,
         COUNT(DISTINCT session_id) AS sessions
    FROM files_touched GROUP BY path;

CREATE VIEW IF NOT EXISTS v_corrections_by_kind AS
  SELECT kind, COUNT(*) AS n,
         COUNT(DISTINCT session_id) AS sessions,
         SUM(COALESCE(followed_by_revert, 0)) AS reverts,
         AVG(preceding_tool_calls) AS avg_tools_before
    FROM user_corrections GROUP BY kind ORDER BY n DESC;

CREATE VIEW IF NOT EXISTS v_failed_commands AS
  SELECT cmd_head, cmd_full, session_id, turn
    FROM shell_commands WHERE exit_code != 0;

CREATE VIEW IF NOT EXISTS v_top_skills AS
  SELECT skill_name, COUNT(*) AS invocations,
         COUNT(DISTINCT session_id) AS sessions
    FROM skills_invoked GROUP BY skill_name;

CREATE VIEW IF NOT EXISTS v_skills_available_usage AS
  SELECT
    av.session_id,
    av.skill_name,
    av.description,
    av.origin,
    av.source_seq,
    av.is_initial,
    CASE
      WHEN EXISTS (
        SELECT 1 FROM skills_invoked si
         WHERE si.session_id = av.session_id
           AND (
             si.skill_name = av.skill_name
             OR av.skill_name LIKE '%:' || si.skill_name
             OR si.skill_name LIKE av.skill_name || '%'
             OR (
               instr(av.skill_name, ':') > 0
               AND substr(av.skill_name, instr(av.skill_name, ':') + 1) = si.skill_name
             )
           )
      ) THEN 1
      WHEN EXISTS (
        SELECT 1 FROM skills_hook_injected hi
         WHERE hi.session_id = av.session_id
           AND (
             hi.skill_slug = av.skill_name
             OR av.skill_name LIKE '%:' || hi.skill_slug
             OR (
               instr(av.skill_name, ':') > 0
               AND substr(av.skill_name, instr(av.skill_name, ':') + 1) = hi.skill_slug
             )
           )
      ) THEN 1
      ELSE 0
    END AS was_used
  FROM skills_available av;

CREATE VIEW IF NOT EXISTS v_session_skill_shelf AS
  SELECT
    session_id,
    COUNT(*) AS skills_loaded,
    SUM(was_used) AS skills_used,
    COUNT(*) - SUM(was_used) AS skills_unused,
    ROUND(100.0 * SUM(was_used) / COUNT(*), 1) AS pct_used
  FROM v_skills_available_usage
 GROUP BY session_id;

CREATE VIEW IF NOT EXISTS v_skill_dead_weight AS
  SELECT
    skill_name,
    COUNT(DISTINCT session_id) AS sessions_loaded,
    COUNT(DISTINCT CASE WHEN was_used = 1 THEN session_id END) AS sessions_used,
    COUNT(DISTINCT session_id)
      - COUNT(DISTINCT CASE WHEN was_used = 1 THEN session_id END) AS sessions_never_used,
    ROUND(
      100.0 * COUNT(DISTINCT CASE WHEN was_used = 0 THEN session_id END)
      / NULLIF(COUNT(DISTINCT session_id), 0),
      1
    ) AS pct_sessions_unused
  FROM v_skills_available_usage
 GROUP BY skill_name
 ORDER BY sessions_loaded DESC;

CREATE VIEW IF NOT EXISTS v_top_mcp AS
  SELECT server, tool, COUNT(*) AS calls,
         COUNT(DISTINCT session_id) AS sessions
    FROM mcp_calls GROUP BY server, tool;

CREATE VIEW IF NOT EXISTS v_top_web AS
  SELECT domain, kind, COUNT(*) AS hits,
         COUNT(DISTINCT session_id) AS sessions
    FROM web_fetches GROUP BY domain, kind;

CREATE VIEW IF NOT EXISTS v_top_subagents AS
  SELECT subagent_type, COUNT(*) AS invocations,
         COUNT(DISTINCT parent_session_id) AS parent_sessions
    FROM subagent_invocations GROUP BY subagent_type;

CREATE VIEW IF NOT EXISTS v_top_sequences AS
  SELECT n, sequence, count, sessions
    FROM tool_call_ngrams ORDER BY count DESC;

CREATE VIEW IF NOT EXISTS v_friction_by_type AS
  SELECT type, COUNT(*) AS n,
         COUNT(DISTINCT session_id) AS sessions
    FROM friction_events GROUP BY type;

CREATE VIEW IF NOT EXISTS v_top_self_resolutions AS
  SELECT s.project_path, sr.tool_name, sr.gap_turns,
         substr(sr.args_preview, 1, 120) AS cmd, sr.session_id, sr.fail_turn
    FROM self_resolutions sr
    JOIN sessions s ON s.id = sr.session_id
   ORDER BY sr.gap_turns DESC;

-- Model pricing (USD per 1M tokens). Populated by \`agentmine prices sync\`
-- from a vendored LiteLLM snapshot (offline default) or live LiteLLM
-- (--online). Keyed by the exact corpus model string; matched_key records
-- the LiteLLM entry it resolved to (NULL = unpriced model, surfaces as
-- NULL/0 cost rather than a wrong $0).
CREATE TABLE IF NOT EXISTS model_prices (
  model TEXT PRIMARY KEY,
  input_per_mtok REAL,
  output_per_mtok REAL,
  cache_read_per_mtok REAL,
  cache_write_per_mtok REAL,
  matched_key TEXT,
  source TEXT NOT NULL DEFAULT 'snapshot',
  updated_at INTEGER
);

-- RAW WORKFLOW TABLES (populated by \`agentmine normalize\`). Lossless verbatim
-- copies of the Claude Code Workflow tool's run manifest + journal, retained so
-- the orchestration layer stays queryable after Claude Code prunes the source
-- (default 30-day cleanup).
CREATE TABLE IF NOT EXISTS raw_workflow_runs (
  run_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  orchestrating_external_id TEXT,
  raw_path TEXT,
  content_hash TEXT,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_workflow_journal (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  agent_id TEXT,
  event_type TEXT,
  key TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_raw_wf_journal_agent ON raw_workflow_journal(run_id, agent_id);

-- FACT TABLES for workflow runs (populated by \`agentmine extract\` from the raw
-- workflow tables). A run groups the agent-sessions of one Workflow invocation
-- under its orchestrating session.
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  orchestrating_session_id TEXT,
  workflow_name TEXT,
  status TEXT,
  agent_count INTEGER,
  total_tokens INTEGER,
  total_tool_calls INTEGER,
  duration_ms INTEGER,
  started_at INTEGER,
  summary TEXT,
  script_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_session ON workflow_runs(orchestrating_session_id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_name ON workflow_runs(workflow_name);
CREATE INDEX IF NOT EXISTS idx_wf_runs_started ON workflow_runs(started_at);

CREATE TABLE IF NOT EXISTS workflow_agents (
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_session_id TEXT,
  phase_index INTEGER,
  phase_title TEXT,
  label TEXT,
  model TEXT,
  state TEXT,
  attempt INTEGER,
  tokens INTEGER,
  tool_calls INTEGER,
  duration_ms INTEGER,
  started_at INTEGER,
  result_preview TEXT,
  result_full TEXT,
  PRIMARY KEY(run_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_wf_agents_session ON workflow_agents(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_wf_agents_phase ON workflow_agents(run_id, phase_index);

CREATE TABLE IF NOT EXISTS workflow_run_phases (
  run_id TEXT NOT NULL,
  phase_index INTEGER NOT NULL,
  title TEXT,
  detail TEXT,
  PRIMARY KEY(run_id, phase_index)
);

CREATE VIEW IF NOT EXISTS v_workflow_scripts AS
  SELECT workflow_name,
         COUNT(*) AS runs,
         SUM(agent_count) AS agents,
         SUM(total_tokens) AS tokens,
         SUM(total_tool_calls) AS tool_calls,
         SUM(duration_ms) AS duration_ms
    FROM workflow_runs
   GROUP BY workflow_name;
`;
