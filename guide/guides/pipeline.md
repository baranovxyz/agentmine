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
agentmine ingest --source claude-code # or cursor, codex, gemini, qwen, cline, pi, droid, vibe
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

`normalize` marks every changed session and raw workflow for extraction. `agentmine stats` exposes
those pending signals as `data.freshness`; `query` and fact-backed browse commands add an
`EXTRACTION_PENDING` warning until `agentmine extract` clears them. The warning keeps reads
non-mutating while preventing a recent normalized date from being mistaken for complete derived
facts.

Freshness is not only about newly normalized content waiting on its first extraction. A fact or
pattern table can also be stale because it was built by an older Agentmine version whose
derivation logic has since changed — upgrading the program does not retroactively correct rows an
earlier version already wrote. The same read commands add a `FACTS_FROM_OLDER_VERSION` warning in
that case, naming `agentmine extract --force` as the recovery. Opening a corpus with a newer
Agentmine invalidates the stale incremental-extract marker automatically, so a routine `agentmine
extract` after upgrading typically rebuilds affected fact tables on its own — see
[Upgrading](upgrading.md) for when `--force` is still needed.

## Safe to rerun

The pipeline is designed to be safe to rerun:

- `sync` mirrors known local transcript stores into Agentmine's session data directory.
- `normalize` parses transcripts into canonical sessions and skips unchanged content by hash
  (content-hash caching — unchanged files are not re-parsed).
- `extract` rebuilds derived fact tables in transactions, so a partial failure does not leave
  half-written tables.
- `backup` snapshots the hot database and every existing payload archive before risky rebuilds
  (for example, before `normalize --force` or a schema rebuild).

## Running it continuously

Everything above describes bringing the corpus up to date *now*. To keep it up to date without
being asked, run these same stages under `agentmine daemon` — see
[Keeping the corpus current](daemon.md).

## No LLM in the default path

The default `sync -> normalize -> extract` path calls no LLM. Optional local embedding requests
live behind explicit `embed` and `similar` commands — see [Similarity search](similarity-search.md).
