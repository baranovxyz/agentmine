# Changelog

Notable Agentmine changes only. Keep this file short; detailed implementation notes belong in
commit history and release notes.

## 0.6.0 - 2026-07-22

- Discovery: the package description, docs, and keywords now lead with the job — long-term memory
  for your coding agents (resume prior work, recall how you solved something before, reconstruct a
  past session) — so humans and their agents find Agentmine by what it does.
- Agent-native discovery: ship a bundled `using-agentmine` skill and an `agentskills` field so a
  coding agent in a repo that has `agentmine` installed can discover when and how to query prior
  sessions.
- Docs: new "Patterns you'll find" section in the guide overview, plus agent-facing pointers in
  getting-started.

## 0.5.0 - 2026-07-22

- `extract` is now incremental: `normalize` marks changed sessions dirty and `extract` rebuilds
  only their fact rows (`--force` still does a full rebuild). A no-op `extract` drops from ~minutes
  to milliseconds on a large corpus; full-rebuild output is unchanged.
- `normalize` skips parsing files whose `(mtime, size)` are unchanged since the last import, instead
  of parsing every file just to recompute the content hash. Adds `skipped_unchanged` to the receipt.
- Add an index on `sessions(parent_session_id)`; the subagent-count rollup and `sessions --parent`
  no longer do a full-table scan per session.

## 0.4.0 - 2026-07-17

- Ingest GitHub Copilot CLI sessions from the per-session `events.jsonl` event stream
  (`~/.copilot/session-state/<uuid>/`), including model, per-message output tokens, session-total
  usage, thinking (`reasoningText`), and tool calls correlated across events by `toolCallId`.
- Source per-CLI transcript parsing from `agent-canonical` 0.1.6 (adds the Copilot parser).

## 0.3.0 - 2026-07-16

- Verify packed CLI and library entrypoints before release.
- Include the complete guide in the npm package and link to the architecture reference.
- Remove bundler-generated source headers from distribution files.
- Replace the native `better-sqlite3` driver with Node's built-in `node:sqlite`
  shim — no native build or prebuilt binary. Requires Node 24+.
- Source per-CLI transcript parsing from the shared `agent-canonical` package
  instead of in-tree codecs.
- Preserve direct Codex parent-session lineage and expose it through session filters.
- Skip sockets and other special files while discovering session transcripts.
- Ingest Gemini CLI JSONL transcripts, including model and token-usage metadata.
- Ingest Qwen Code JSONL transcripts, including model, token usage, thinking, and correlated tool
  results.
- Ingest Cline root and subagent/team session JSON, honoring Cline's session-directory overrides
  and including model, token usage, thinking, and correlated tool results. Root metadata-only
  changes invalidate the normalize cache and count as fresh for `--since`.
- Ingest Kilo Code sessions from its local SQLite store.
- Ingest Goose sessions from its platform-aware global SQLite store, honoring `GOOSE_PATH_ROOT`
  and including correlated cross-turn tool calls.
- Ingest Claude Code workflow manifests and journals as first-class workflow runs, with commands
  for ranking runs and inspecting their phases and agents.
- Move runtime validation to Zod 4.
- Recover Cursor session `started_at` from transcript timestamp tags, with raw
  JSONL file mtime as a fallback.
- Filter ingested sessions by a `project_path` allowlist.
- Serialize concurrent DB writes across processes with an advisory lock, so a
  SessionStart `normalize` and a scheduled `ingest` can't clobber each other.

## 0.2.0 - 2026-06-11

- First npm release.
- Rename public surface to Agentmine / `agentmine` / `AGENTMINE_*`.
- Use session terminology consistently, including bundled session skills.
- Store corpus data under the XDG/AppData sessions root with `sessions.db`.
- Add multi-source session ingest for Claude Code, Cursor, Codex, and opencode.

## 0.1.0 - 2026-04-23

- Initial local SQLite session corpus for Claude Code.
- Added sync, normalize, extract, browse, query, and schema commands.
