---
title: CLI command overview
description: Overview of Agentmine's common browse, search, pipeline, and maintenance commands.
---

**Agentmine** (`agentmine`) exposes its corpus through browse, search, pipeline, and maintenance
commands. This page covers the common commands rather than every flag. All commands emit an
agent-friendly JSON envelope — see the
[Agent CLI contract](agent-contract.md).

## Browse

| Command | Purpose |
|---|---|
| `agentmine stats` | Corpus overview |
| `agentmine sessions --limit 20` | List sessions |
| `agentmine sessions --root-only --since 1d` | List top-level sessions without child workers or reviewers |
| `agentmine sessions --parent <session-id>` | List one session's direct children |
| `agentmine sessions --agent-type guardian` | List automatic Codex action-review sessions |
| `agentmine session <session-id> --md` | Render a session as Markdown |
| `agentmine session <id> --turn-range 10:20` | Inspect a compact slice of a session |
| `agentmine top files --limit 20` | Rank most-touched files |
| `agentmine top commands --failed --limit 20` | Rank commands, optionally failed-only |
| `agentmine top corrections --by kind` | Rank user corrections by kind |
| `agentmine top skills` | Rank skills used |
| `agentmine top tokens --by model\|project\|session\|day\|source` | Rank by token volume + USD cost (run `prices sync` first; incomplete prices make `cost_usd` a lower bound and increment `unpriced_sessions`) |
| `agentmine top sequences --project '/path/to/repo%' --n 3` | Re-aggregate ngrams scoped to a `project_path` LIKE pattern |
| `agentmine timeline --bucket week` | Activity timeline |
| `agentmine workflows --sort tokens` | Rank Claude Code workflow runs by start time, tokens, duration, agents, or name |
| `agentmine workflow <run-id>` | Inspect one workflow run's rollups, phases, and per-agent rows |
| `agentmine version` | Report Agentmine, runtime, target, Bun, and source-commit metadata |
| `agentmine schema` | Inspect the result-envelope schema, exit codes, and top-level command registry |
| `agentmine schema --tables` | List database tables and views |
| `agentmine schema --table messages` | Inspect DB columns before writing SQL |

## Search

```bash
agentmine fts "error text or phrase"
agentmine similar "task description"
agentmine similar "today's task" --root-only --since 1d
```

See [Similarity search](../guides/similarity-search.md) for `similar`'s `auto`/`hybrid`/`embedding`
modes, time and lineage filters, and injected-message behavior.

**Hyphenated phrases:** FTS5 reads `agent-first` as a filter on a column named `first`, so the raw
query is rejected. `fts` notices, retries once with bare terms quoted, and returns the rows with a
`QUERY_SANITIZED` warning naming what it ran. Quote them yourself to skip the retry and control
matching exactly:

```bash
agentmine fts '"agent-first"'
```

A query that already parses as FTS5 — column filters, `AND`/`OR`/`NOT`/`NEAR`, `*` prefixes — is
never rewritten.

## Ad-hoc SQL

```bash
agentmine query "SELECT source, count(*) AS n FROM sessions GROUP BY source"
```

Ad-hoc SQL is read-only. `SELECT`, `WITH`, `EXPLAIN`, and read-only introspection `PRAGMA`s
(`table_info`, `table_list`, `index_list`, …) are accepted; assignment pragmas such as
`PRAGMA user_version = 5` are not. Only the first statement is ever compiled, so anything after a
`;` is ignored rather than run.

A statement that names a column or table the corpus does not have reports the nearest real names
alongside the database's own message, so check the suggestion before re-reading the schema. Column
names seen in command output are not always columns — `started_at_iso` and
`first_user_prompt_preview` are derived; the stored columns are `started_at` and `first_user_prompt`.

## Pipeline

| Command | Purpose |
|---|---|
| `agentmine ingest` | `sync -> normalize -> extract` in one step |
| `agentmine daemon` | Keep the corpus current continuously, instead of importing on demand |
| `agentmine sync` | Mirror known local transcript stores into the session data directory |
| `agentmine normalize` | Parse transcripts into canonical sessions (content-hash cached) |
| `agentmine normalize --since 1d` | Incremental: only parse files touched in the last day (mtime-filtered walk) |
| `agentmine extract` | Rebuild derived fact tables in transactions |
| `agentmine embed --provider ollama --model nomic-embed-text --dry-run` | Plan a local semantic index without writing |

`agentmine ingest --source claude-code|cursor|codex|gemini|qwen|cline|pi|droid|vibe` runs the
three file-based stages for one installed CLI. Current OpenCode, Kilo Code, and Goose use
`agentmine normalize --source opencode-db`, `agentmine normalize --source kilo`, or `agentmine
normalize --source goose`, followed by `agentmine extract` for a source-specific import; their
live SQLite stores are not `sync` targets. An unfiltered `agentmine ingest` includes available
live databases during its `normalize` stage.

`agentmine daemon` runs those same stages for you, on its own, for as long as it
is running, so a query reflects what your agents were doing seconds ago rather
than whenever you last ran `ingest`. Detection cadence, running it as a service,
and how upgrades behave are covered in
[Keeping the corpus current](../guides/daemon.md).

```bash
agentmine daemon                          # every installed CLI
agentmine daemon --only claude-code,codex # just these
agentmine daemon --no-extract             # import sessions, skip fact tables
agentmine daemon --print-service          # generate a service definition
agentmine daemon --install-service        # write it, print how to enable
```

## Maintenance

| Command | Purpose |
|---|---|
| `agentmine backup` | Snapshot the complete SQLite corpus before `normalize --force` or other rebuilds |
| `agentmine compact --dry-run` | Plan the one-time 0.8.x corpus storage split and check required disk space |
| `agentmine compact` | Move verbatim payload into compressed sibling archives; resumable after interruption |
| `agentmine prices sync` | Load `model_prices` from the vendored LiteLLM snapshot (offline); `--online` fetches live LiteLLM |
| `agentmine prices ls` | List the loaded price table (USD per 1M tokens) |
| `agentmine purge --project-path-allow <substring>` | Dry-run purge of sessions outside an allowlist |
| `agentmine purge --project-path-allow <substring> --yes` | Delete sessions outside an allowlist |

Agentmine 0.9 refuses normal corpus commands when it finds the pre-0.9 single-database layout.
Run `agentmine compact --dry-run`, then `agentmine compact`. `agentmine backup` and the two compact
forms remain available before migration so the recovery path never depends on a successful write.
