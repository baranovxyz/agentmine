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

## Corpus freshness warnings

`agentmine stats` returns a `data.freshness` snapshot for the boundary between normalized inputs
and extract-owned facts. Pending sessions and changed raw workflows are tracked independently.
When either still needs extraction, `stats`, `query`, and fact-backed browse commands add an
`EXTRACTION_PENDING` warning to the normal success envelope.

This includes `sessions` and the default JSON form of `session`, whose payloads expose derived
commit and subagent fields. `session --md` renders only normalized transcript data and does not add
the warning.

The warning does not change the result rows, exit code, or status. Treat derived fact results as
incomplete until `agentmine extract` succeeds; normalized-session commands can still be used.

The same commands also add a `FACTS_FROM_OLDER_VERSION` warning when a full rebuild of the fact
tables is scheduled and has not run yet. This is a distinct staleness signal from
`EXTRACTION_PENDING`: the dirty-session tracker only knows about new or changed inputs, not about a
code change that reinterprets inputs it already processed. A full rebuild is scheduled by an
agentmine upgrade whose fact-derivation logic changed — the underlying migration clears the
incremental-extract marker, which is what makes the next ordinary `agentmine extract` rebuild
everything rather than just what changed. The warning is deliberately NOT keyed on the recorded
extraction version differing from the running one: that would fire on every release, including ones
that changed no derivation at all, training callers to ignore it. `data.freshness` still reports
`last_extract_version` (the version that last fully populated the fact tables) for diagnosis, and
folds the scheduled rebuild into `facts_current`, so existing consumers of that boolean see it go
stale without any change on their part. Run plain `agentmine extract` to clear it — `--force` is not
needed, because the missing marker already forces that run to rebuild the whole corpus rather than
just the sessions changed since the last run.

## Schema discovery

Run `agentmine schema` to inspect the result-envelope schema, exit codes, and top-level command
registry. Use
`agentmine schema --tables` to list database tables and views, or
`agentmine schema --table messages` to inspect one table before writing ad-hoc SQL.

`agentmine query` also accepts read-only introspection `PRAGMA` statements — `table_info`,
`table_list`, `index_list`, and similar — so the schema can be discovered from inside a query
session. Assignment forms (`PRAGMA x = y`) stay rejected and the database is still opened read-only.
Only the first statement is compiled, so anything following a `;` is ignored rather than executed.

Do not treat a command's output field names as column names. `sessions` and `workflows` emit derived
fields such as `started_at_iso`, `ended_at_iso`, `first_user_prompt_preview`, and
`reconstruct_command` that do not exist in the schema; the stored columns are `started_at` and
`ended_at` (epoch seconds) and `first_user_prompt`.

## Interpreted input

When a strict reading fails, `fts` and `session` retry once with a single unambiguous
interpretation, and the successful envelope names what was substituted:

- `QUERY_SANITIZED` — the full-text query was rejected by FTS5 and rerun with its bare terms
  quoted. Hyphenated prose (`no-show`, `agent-first`) parses as column-filter syntax otherwise.
  Quoted spans, `AND`/`OR`/`NOT`/`NEAR`, parentheses, and trailing `*` are preserved.
- `SESSION_ID_RESOLVED` — the session id was matched by external id, by a missing source prefix, or
  by unique prefix rather than exactly.

Neither warning changes the rows, status, or exit code. A query that already parses is never
rewritten, and an id that matches more than one session is an error naming the candidates rather
than a guess. Treat either warning as a signal to pin the exact form in anything you store.
