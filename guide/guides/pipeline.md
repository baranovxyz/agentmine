---
title: The pipeline
description: How Agentmine's sync, normalize, extract, and query stages work together safely.
---

**Agentmine** builds its corpus through four stages: sync, normalize, extract, and querying. Each
stage has a narrow, well-defined job, and the sequence is designed to be safe to rerun.

## The four stages

- `sync` mirrors known local transcript stores into Agentmine's session data directory.
- `normalize` parses transcripts into canonical sessions and skips unchanged content by hash.
- `extract` rebuilds derived fact tables in transactions.
- Querying reads the resulting core and fact tables through browse commands such as `stats`,
  `top`, `session`, and `similar`, or through ad-hoc read-only SQL via `query`.

Run all three file-based ingest stages for one installed CLI with:

```bash
agentmine ingest --source claude-code # or cursor, codex, gemini, qwen, or cline
```

An unfiltered `agentmine ingest` expects the default Claude Code transcript directory to exist.
Current opencode, Kilo Code, and Goose stores instead use `agentmine normalize --source
opencode-db`, `agentmine normalize --source kilo`, or `agentmine normalize --source goose`, then
`agentmine extract` for a source-specific import, because their live SQLite databases are not sync
targets. An unfiltered `agentmine ingest` also picks up any available live databases during its
unfiltered `normalize` stage.

When Claude Code is included, `normalize` also reads workflow manifests and journals from the
source session tree into lossless workflow tables. `extract` derives run, phase, and agent
rollups for `agentmine workflows` and `agentmine workflow <run-id>`.

## Safe to rerun

The pipeline is designed to be safe to rerun:

- `sync` mirrors known local transcript stores into Agentmine's session data directory.
- `normalize` parses transcripts into canonical sessions and skips unchanged content by hash
  (content-hash caching — unchanged files are not re-parsed).
- `extract` rebuilds derived fact tables in transactions, so a partial failure does not leave
  half-written tables.
- `backup` snapshots `sessions.db` before risky rebuilds (for example, before `normalize --force`
  or a schema rebuild).

## No LLM in the default path

The default `sync -> normalize -> extract` path calls no LLM. Optional local embedding requests
live behind explicit `embed` and `similar` commands — see [Similarity search](similarity-search.md).
