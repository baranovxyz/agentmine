---
title: Redaction & privacy
description: How Agentmine redacts secrets during normalization and its local-first data stance.
---

**Agentmine** redacts high-confidence secret patterns before storing searchable message text and
keeps all data local by default. Lossless source records remain sensitive.

## What gets redacted

Normalization redacts high-confidence secret patterns before storing searchable text. Built-in
patterns cover:

- common API keys
- bearer tokens
- private keys
- OAuth-style tokens
- Slack tokens
- AWS access key IDs
- GitHub token prefixes
- secret-shaped environment values

## Disabling redaction

Use `--no-redact` only for a deliberate local audit where preserving exact text is required.
This flag controls canonical session fields; workflow records described below remain sensitive in
either mode.

## Lossless records remain unredacted

Redaction protects normalized searchable session text and canonical message and tool previews. It
does not make every bounded value in the database safe. Lossless JSON and full-output fields may
retain secrets: this includes `raw_events.raw_json`, `tool_outputs.output_text`,
`tool_calls.args_json`, and `message_parts.payload_json`.

Workflow ingest is a separate lossless path and does not pass through canonical session redaction.
`raw_workflow_runs.raw_json`, `raw_workflow_runs.raw_path`, and
`raw_workflow_journal.raw_json` retain source values. Derived fields copied from those records —
including `workflow_runs.summary`, `workflow_runs.script_path`,
`workflow_run_phases.detail`, `workflow_agents.result_preview`, and
`workflow_agents.result_full` — may also retain secrets. The `agentmine workflow` command bounds
the `result_full` excerpt size but does not redact it.

Synced raw transcript archives also keep their original content. Protect the data directory,
`sessions.db`, command output, and backup archives as sensitive local data; do not publish or share
them without a separate review.

## Local-first data stance

Agentmine is local-first. It reads local transcript stores and writes local SQLite data under the
user data directory by default (see [Data paths](../reference/data-paths.md)). It does not call an
LLM in the default `sync -> normalize -> extract` path, so session content does not leave the
machine during ordinary ingest.
