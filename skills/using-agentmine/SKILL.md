---
name: using-agentmine
description: Use this skill when working in a repo and you want to know whether similar work was done before, which commands or tool errors recur, what corrections keep coming up, or which skills/MCP tools actually get used. Agentmine turns local AI coding-agent session transcripts into a queryable local SQLite corpus. Trigger on "have I done this before", "what failed last time", "search my agent history", "find a prior session".
---

# Using Agentmine

Agentmine (`agentmine`) is long-term memory for AI coding agents — a local, agent-first CLI over
your session history (Claude Code, Cursor, Codex, Copilot, Gemini, Qwen, Kilo Code, Goose, Cline,
and OpenCode). Every command emits one JSON envelope on stdout; run `agentmine schema` to discover
the contract, exit codes, and command registry before you script it.

## When this helps

- **Resume prior work** — reload what you (or a past agent) were doing before continuing, instead
  of starting cold.
- **Reuse a past solution** — before non-trivial work, check whether you already solved something
  like this, so you don't re-derive it.
- **Reconstruct a session** — see what a specific past session actually did: its decisions, changes,
  and outcome.
- **Recall a specific change** — trace when and in which session a value, config, or decision was
  set.
- **Spot recurring friction** (secondary) — which shell commands or tool calls keep failing, and
  which corrections keep coming up.

## First run (idempotent, local-only, no LLM)

```bash
# File-based stores — pick the source you have:
agentmine ingest --source claude-code   # or cursor | codex | gemini | qwen | cline | copilot

# Live SQLite stores (OpenCode, Kilo Code, Goose):
agentmine normalize --source opencode-db && agentmine extract
```

The default `sync -> normalize -> extract` path reads local transcript stores and writes a local
`sessions.db`. Nothing leaves your machine and no LLM is called.

## Query it

```bash
agentmine sessions --root-only --since 1d   # what you were working on — reopen and continue
agentmine session <id> --turn-range 1:20    # reconstruct a past session (JSON or markdown)
agentmine similar "auth redirect loop"      # find a prior session that solved something like this
agentmine fts "checkout redirect"           # locate the session where you changed/decided X
agentmine top commands --failed             # (secondary) recurring shell failures
agentmine top skills                        # (secondary) which reusable instructions get used
agentmine schema --tables                   # then: agentmine query "SELECT ..." for anything else
```

Full documentation: <https://agentmine.io>
