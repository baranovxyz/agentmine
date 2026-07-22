---
title: Overview
description: Agentmine turns local AI coding-agent session transcript archives into a queryable SQLite corpus.
---

**Agentmine** (`agentmine`) is long-term memory for your AI coding agents. It turns local session
transcript archives into a searchable SQLite corpus, so you — or your agent — can resume prior
work, recall how you solved something before, and reconstruct what a past session did.

It ingests session transcripts from tools such as Claude Code, Cursor, Codex, Gemini CLI, Qwen
Code, Cline, GitHub Copilot CLI, Kilo Code, Goose, and OpenCode, normalizes them into a shared
schema, extracts useful facts, and exposes the result through an agent-friendly JSON CLI.

## Answer questions like

- What was I working on — can I pick up where I left off?
- Have I solved a task like this before?
- What did that past session actually do — its decisions and outcome?
- When did I change this, and in which session?
- What files and commands do my agents touch most, and which errors or corrections repeat?
- Which skills, MCP tools, or agent workflows are actually used?

## Patterns you'll find

Once your history is in one corpus, the same shapes tend to surface across projects. A few worth
running on your own data:

- **Edit-before-read is usually the largest bucket of recoverable tool errors** — an agent edits or
  writes a file it never read. Surface it with `agentmine top errors` (look for `Edit` /
  `file_not_read`).
- **Most corrections are refinements, not rejections.** Agents get close and get nudged, rather
  than told to start over. Break it down with `agentmine top corrections --by kind`.
- **A handful of skills carry most of the load.** Invocation counts are heavily skewed — a few
  reusable instructions dominate and the rest are rarely reached. Rank yours with
  `agentmine top skills`.
- **The same commands keep failing.** Recurring shell failures cluster tightly; fix the pattern
  once instead of the instance. List them with `agentmine top commands --failed`.

Every one of these is a plain query over the fact tables, so you can confirm the shape on your own
corpus rather than taking the general claim on faith.

## Local-first

Agentmine is local-first. It reads local transcript stores and writes local SQLite data under the
user data directory by default. It does not call an LLM in the default `sync -> normalize ->
extract` path.

## How it fits together

Agentmine is organized into three layers, each with a stable contract:

1. **Adapters** read per-tool source data and emit a common canonical session shape.
2. **DB writer** upserts that canonical shape into the core and lossless tables idempotently.
3. **Extractors** read tool calls and messages, and write derived fact tables.

Browse commands (`stats`, `top`, `session`, `similar`, and others) then read from the core and fact
tables through the agent-friendly JSON CLI.

Continue to [Getting started](getting-started.md) to install Agentmine and run your first import.
