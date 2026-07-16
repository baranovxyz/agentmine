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
```

## Auto mode

By default, `similar` runs in `auto` mode:

- It uses FTS when no local embedding index is available.
- It can use hybrid search when local embeddings exist and guardrails are satisfied.
- It returns reconstruction commands such as `agentmine session <id> --md`.

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
