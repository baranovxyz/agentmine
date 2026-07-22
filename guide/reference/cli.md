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
| `agentmine top tokens --by model\|project\|session\|day\|source` | Rank by token volume + USD cost (run `prices sync` first; unpriced models report 0 + `unpriced_sessions`) |
| `agentmine top sequences --project '/path/to/repo%' --n 3` | Re-aggregate ngrams scoped to a `project_path` LIKE pattern |
| `agentmine timeline --bucket week` | Activity timeline |
| `agentmine workflows --sort tokens` | Rank Claude Code workflow runs by start time, tokens, duration, agents, or name |
| `agentmine workflow <run-id>` | Inspect one workflow run's rollups, phases, and per-agent rows |
| `agentmine schema` | Inspect the result-envelope schema, exit codes, and top-level command registry |
| `agentmine schema --tables` | List database tables and views |
| `agentmine schema --table messages` | Inspect DB columns before writing SQL |

## Search

```bash
agentmine fts "error text or phrase"
agentmine similar "task description"
```

See [Similarity search](../guides/similarity-search.md) for `similar`'s `auto`/`hybrid`/`embedding`
modes.

**FTS5 hyphen gotcha:** FTS5 parses `agent-first` as `agent MINUS first`. Wrap hyphenated phrases in
double quotes:

```bash
agentmine fts '"agent-first"'
```

## Ad-hoc SQL

```bash
agentmine query "SELECT source, count(*) AS n FROM sessions GROUP BY source"
```

Ad-hoc SQL is read-only. Only `SELECT`, `WITH`, and `EXPLAIN` queries are accepted.

## Pipeline

| Command | Purpose |
|---|---|
| `agentmine ingest` | `sync -> normalize -> extract` in one step |
| `agentmine sync` | Mirror known local transcript stores into the session data directory |
| `agentmine normalize` | Parse transcripts into canonical sessions (content-hash cached) |
| `agentmine normalize --since 1d` | Incremental: only parse files touched in the last day (mtime-filtered walk) |
| `agentmine extract` | Rebuild derived fact tables in transactions |
| `agentmine embed --provider ollama --model nomic-embed-text --dry-run` | Plan a local semantic index without writing |

`agentmine ingest --source claude-code|cursor|codex|gemini|qwen|cline` runs the three file-based
stages for one installed CLI. Current OpenCode, Kilo Code, and Goose use `agentmine normalize
--source opencode-db`, `agentmine normalize --source kilo`, or `agentmine normalize --source
goose`, followed by `agentmine extract` for a source-specific import; their live SQLite stores are
not `sync` targets. An unfiltered `agentmine ingest` includes available live databases during its
`normalize` stage.

## Maintenance

| Command | Purpose |
|---|---|
| `agentmine backup` | Snapshot `sessions.db` before `normalize --force` or other rebuilds |
| `agentmine prices sync` | Load `model_prices` from the vendored LiteLLM snapshot (offline); `--online` fetches live LiteLLM |
| `agentmine prices ls` | List the loaded price table (USD per 1M tokens) |
| `agentmine purge --project-path-allow <substring>` | Dry-run purge of sessions outside an allowlist |
| `agentmine purge --project-path-allow <substring> --yes` | Delete sessions outside an allowlist |
