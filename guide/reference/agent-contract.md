---
title: Agent CLI contract
description: The stable JSON envelope, error codes, and progress channel Agentmine gives automation.
---

**Agentmine** is built for agents and automation. Every command follows the same contract, so a
calling agent or script can rely on stable structure instead of parsing human-oriented text.

## The contract

- stdout is one JSON envelope.
- warnings are returned in the stdout envelope's `warnings` field.
- progress goes to stderr as NDJSON.
- errors include stable codes and retry guidance.
- commands are non-interactive by default.
- schema discovery is available through `agentmine schema`.

## Error codes

Errors carry a stable code and fall into one of three ranges, each mapped to a specific process
exit code:

| Range | Category | Exit code |
|---|---|---|
| 1xxx | user | 2 |
| 2xxx | system | 3 |
| 3xxx | transient | 4 |

Transient (3xxx) errors are the ones worth an automatic retry; user (1xxx) errors mean the
invocation itself needs to change; system (2xxx) errors indicate an environment or internal
problem.

## Progress on stderr

Progress is reported as throttled NDJSON events on stderr — for example a `phase.sub` event
carrying `current`, `total`, and `processed` counts — so stdout stays reserved for the final JSON
result and a long-running command (like `normalize` or `extract` over a large corpus) can still be
monitored line-by-line.

An extension that fails during startup may also emit an unstructured diagnostic on stderr before
the final envelope. Callers should treat only JSON objects with a progress-event shape as progress.

## Schema discovery

Run `agentmine schema` to inspect the result-envelope schema, exit codes, and top-level command
registry. Use
`agentmine schema --tables` to list database tables and views, or
`agentmine schema --table messages` to inspect one table before writing ad-hoc SQL.
