---
title: Similarity search
description: Find prior Agentmine sessions with agentmine similar, in FTS, hybrid, or embedding mode.
---

`agentmine similar` is **Agentmine**'s main entry point for finding prior work.

## Usage

```bash
agentmine similar "React Router auth redirect loop" --limit 5
agentmine similar "schema migration" --source codex
agentmine similar "test flake timeout" --project /path/to/repo
agentmine similar "today's agentic docs work" --root-only --since 1d
```

## Auto mode

By default, `similar` runs in `auto` mode:

- It uses FTS when no local embedding index is available.
- It can use hybrid search when local embeddings exist and guardrails are satisfied.
- It returns reconstruction commands such as `agentmine session <id> --md`.
- It excludes runtime-injected instructions, skill payloads, hook feedback, compaction handoffs,
  and automatic approval transcripts from matching content.

Pass `--include-injected` only for corpus diagnostics. It restores those messages to both lexical
and semantic candidate searches and preserves raw injected session titles; otherwise those titles
are returned as `null`.

## Time and lineage filters

Use `--root-only` to exclude normalized child workers and automatic reviewers. Combine it with
`--since` and `--until` for a bounded investigation:

```bash
agentmine similar "agent-context-kit agentic docs" \
  --all-projects \
  --root-only \
  --since "2026-07-23T00:00:00+03:00" \
  --until "2026-07-24T00:00:00+03:00"
```

`--since` is inclusive and `--until` is exclusive for ISO timestamps. A bare `YYYY-MM-DD`
`--until` includes that complete UTC day, matching the shared Agentmine date-filter contract.
Impossible calendar dates are rejected instead of rolling into a later month. When the user's day
is not UTC, pass explicit ISO offsets as shown above.

## Optional local embeddings

Local embeddings are optional. To enable semantic and hybrid search, pull an embedding model with
Ollama and build the local index:

```bash
ollama pull nomic-embed-text
agentmine embed --provider ollama --model nomic-embed-text --dry-run
agentmine embed --provider ollama --model nomic-embed-text --limit 500
agentmine similar "agent first CLI JSON stdout stderr" --mode hybrid
```

`embed --dry-run` plans the run without writing chunks, vectors, or run receipts. Once you have
run it without `--dry-run`, `similar` can select hybrid mode automatically, or you can request it
explicitly with `--mode hybrid` (or `--mode embedding` for pure semantic retrieval).

Scope an embedding run to recent work with `--since` — it accepts an ISO date (`YYYY-MM-DD`) or a
relative offset such as `7d`, `2w`, or `12h`, and filters both planning and the pending-chunk
queries by session start time, so only chunks from sessions in the window get embedded.
