# Changelog

Notable Agentmine changes only. Keep this file short; detailed implementation notes belong in
commit history and release notes.

## 0.11.0 - 2026-08-19

**Existing corpora need `agentmine extract --force` after upgrading.** This release changes what
several fact tables contain, and rows produced by earlier versions are not corrected automatically.
Run `agentmine backup` first.

- Derive shell facts by parsing the command as shell rather than by matching text within it. Text
  that merely resembles an invocation — a tool named inside a quoted argument, a heredoc body, or
  another command's operand — no longer produces a fact row. A command that cannot be parsed
  produces no rows at all, because a fact table is better missing a row than carrying one that
  describes a command that never ran.
- Store each shell command whole. Commands were previously capped, which cut roughly one in six
  mid-quote or mid-heredoc; to a parser that is indistinguishable from malformed input, so those
  commands lost every fact, not just the part past the cut.
- Report the command a shell invocation actually ran. The short name was taken from a whitespace
  split that stopped at the first shell metacharacter, which a split cannot tell from an ordinary
  character inside quotes: `IFS=';' read …` and `PGPASSWORD="a;b" psql …` were recorded as having
  no command at all, and a script that binds a variable before using it was attributed to the
  variable. Shell keywords such as `for` are no longer reported as though they were programs.
- Report a session as having committed based on whether a commit actually ran. It was previously
  based on the last command whose text contained the phrase, so a later `grep` for that phrase, or
  a commit message quoting it, replaced a successful commit with an unrelated command's outcome.
- Report the full path of a repeatedly read file, including paths containing `::`.
- Interpret an unambiguous near miss on the read surface instead of only rejecting it. The strict
  reading is still attempted first and is unchanged; only once it fails does a command retry a
  single unambiguous interpretation, and any result reached that way carries a warning naming the
  substitution. `query` suggests the near-miss table or column it thinks was meant, `fts` retries a
  query the full-text engine rejected with its terms quoted, and `session` resolves a session id
  given in a form close enough to identify exactly one session.
- Name the command that resolves the problem in every actionable rejection, including the case
  where the corpus is newer than the binary being run.
- Let `sessions --where` accept a semicolon inside a predicate. A semicolon in a string literal is
  data, not a statement separator, and rejecting it turned an ordinary title filter into an error.
- Report the schema on request, so a query can be written against the corpus without guessing at
  table and column names first.

## 0.10.0 - 2026-08-18

- Add `agentmine daemon`, which keeps the corpus current on its own by scanning
  each session store at a cadence matched to how recently it was written, so a
  location written moments ago is detected in seconds while a dormant one costs
  nothing to watch. Imports settle before running and are dispatched at a ceiling
  regardless, so a session being written continuously — the one most likely being
  watched — still imports. Fact extraction runs on its own slower cadence with
  its own ceiling. Only one daemon may run against a corpus; liveness is recorded
  in the corpus itself, so a daemon that has stopped importing is distinguishable
  from a machine with nothing to import.
- Generate a systemd user unit or launchd agent for the daemon with
  `--print-service` / `--install-service`. Generating writes a file and stops
  there: enabling and removing stay the operator's, and the commands for both are
  printed.
- Refuse to generate a service definition naming a program that may not survive —
  one inside a source-control checkout, linked into one, under the temporary
  directory, or absent. A definition names its program permanently, so this
  otherwise produces a service that fails silently while the corpus stops
  advancing. `--allow-ephemeral-path` supervises a development build anyway.
- Stand down when superseded. A running daemon detects that its own program was
  replaced, or that a newer Agentmine migrated the corpus, and exits as a fault so
  its supervisor restarts it into the current version — no packaging channel
  restarts a per-user service, and a process that kept running would feed the
  corpus from a version its own commands had left behind.
- Warn `DAEMON_NOT_RUNNING` on read commands when a corpus with an installed
  service definition has not been imported within the slowest detection bound.

## 0.9.0 - 2026-08-13

- Move verbatim source events and complete tool output into compressed sibling SQLite archives,
  reducing the hot database to the data used by interactive queries. Existing corpora migrate only
  through the explicit, space-checked, resumable `agentmine compact` command; routine commands do
  not start the migration and refuse to open a pre-0.9 corpus until it is compacted.
- Report corpus and extraction freshness on read commands instead of silently presenting stale
  fact-derived results, and preserve child-command failures in the top-level `agentmine ingest`
  receipt.
- Narrow incremental extraction candidate scans to the affected sessions and move skill-listing
  recovery to normalization, removing the full verbatim-payload scan from extraction.
- Back up the hot database and every existing payload archive under one corpus lock, and make
  payload purges resumable so interrupted maintenance cannot retain untracked private content.
- Add a repeatable cold-import benchmark and verify compressed payload round-trips through the Bun
  1.3.14 standalone runtime.

## 0.8.0 - 2026-08-04

- Ingest Pi sessions from the append-only per-session JSONL store
  (`~/.pi/agent/sessions/<cwd-slug>/`), including thinking, per-message token usage, in-place
  branches, and tool calls correlated by tool-call ID.
- Ingest Factory Droid sessions from the per-session JSONL plus its `<id>.settings.json` sibling
  (`~/.factory/sessions/<cwd-slug>/`), including the model alias, session token totals, thinking,
  and tool results correlated Anthropic-style by tool-use ID.
- Ingest Mistral Vibe sessions from the per-session directory (`~/.vibe/logs/session/<name>/`),
  reading `messages.jsonl` plus the `meta.json` sidecar for identity, timing, project path, git
  branch, model, and token totals.
- A sidecar-only rewrite now refreshes the Droid and Vibe rows it owns instead of being skipped as
  up to date, so session token totals cannot go stale.
- Source per-CLI transcript parsing from `agent-canonical` 0.3.0 (adds the Pi, Droid, and Vibe
  parsers).

## 0.7.2 - 2026-08-03

- Move to Agent Canonical 0.2.1 so corrected Codex fork and cache-write token accounting remains
  available alongside the rollout-family materializer required by Arcadia.
- Fail closed when source plans contain malformed Codex JSONL or an explicit successful spawn has
  no authoritative child identity.

## 0.7.1 - 2026-08-02

- Correct Codex fork usage and cache-cost accounting, preserve cache-write tokens, and report
  incomplete model prices as lower-bound estimates.
- Reparse cached Codex sessions once during ordinary post-upgrade normalize or ingest so existing
  corpora receive corrected usage without `--force`.
- Reject malformed token counters and future database schemas before pricing or mutation.
- Keep dry runs read-only and serialize every migration-capable database writer.

## 0.7.0 - 2026-07-23

- Distribution: publish Linux x64, macOS x64, and macOS arm64 standalone executables alongside
  the existing npm package under one Agentmine version.
- Runtime parity: compiled executables support the full CLI, including SQLite ingest and backup,
  self-executing `ingest`, user extensions, embeddings, and online or offline model prices.
- Release integrity: all three native builds must pass smoke and secret scans before npm
  publication; immutable GitHub release assets are bound by a canonical manifest and SHA-256
  checksums.
- Discovery: add `agentmine version` for machine-readable runtime, target, Bun version, and source
  commit metadata while preserving plain semantic-version output from `agentmine --version`.

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
