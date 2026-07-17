---
title: Overview
description: Agentmine turns local AI coding-agent session transcript archives into a queryable SQLite corpus.
---

**Agentmine** (`agentmine`) turns local AI coding-agent session transcript archives into a
queryable SQLite corpus.

It ingests session transcripts from tools such as Claude Code, Cursor, Codex, Gemini CLI, Qwen
Code, Cline, GitHub Copilot CLI, Kilo Code, Goose, and opencode, normalizes them into a shared
schema, extracts useful facts, and exposes the result through an agent-friendly JSON CLI.

## Answer questions like

- What files and commands do my agents touch most?
- Which failed commands or tool errors repeat?
- What corrections do I keep giving agents?
- Have I solved a similar task before?
- Which skills, MCP tools, or agent workflows are actually used?

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
