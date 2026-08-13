---
title: Data paths
description: Where Agentmine stores mirrored transcripts, the SQLite corpus, and backups.
---

**Agentmine** stores mirrored transcripts, the SQLite corpus, and backups under its user data
directory by default.

## Default location

Default paths live under Agentmine's user data directory:

- macOS/Linux: `$XDG_DATA_HOME/agentmine/sessions/` when set, otherwise
  `~/.local/share/agentmine/sessions/`.
- Windows via WSL: the same Linux path inside WSL. Native path resolution uses
  `%APPDATA%\agentmine\sessions\`, but end-to-end native CLI workflows are not supported because
  sync and backup require `rsync` and `tar`.

## Layout

| Path | Purpose |
|---|---|
| `<sessions>/claude-code/` | mirrored Claude Code transcripts |
| `<sessions>/cursor/` | mirrored Cursor transcripts |
| `<sessions>/codex/` | mirrored Codex sessions |
| `<sessions>/gemini/` | mirrored Gemini CLI transcripts from `~/.gemini/tmp/` |
| `<sessions>/qwen/` | mirrored Qwen Code transcripts from `~/.qwen/projects/` |
| `<sessions>/cline/` | mirrored Cline session JSON from Cline's resolved sessions directory |
| `<sessions>/copilot/` | mirrored GitHub Copilot CLI event streams from `~/.copilot/session-state/` |
| `<sessions>/pi/` | mirrored Pi session JSONL from `~/.pi/agent/sessions/` |
| `<sessions>/droid/` | mirrored Factory Droid session JSONL + settings siblings from `~/.factory/sessions/` |
| `<sessions>/vibe/` | mirrored Mistral Vibe session directories from `~/.vibe/logs/session/` |
| `<sessions>/opencode/` | legacy file-based opencode archives, when present |
| `<sessions>/sessions.db` | Hot SQLite database used by browse, search, and reporting commands |
| `<sessions>/sessions-raw.db` | Compressed verbatim source events; attached only when a command needs them |
| `<sessions>/sessions-tools.db` | Compressed full tool output; attached only when a command needs it |
| `<sessions>/backups/` | backup archives |

Current OpenCode, Kilo Code, and Goose sessions are read directly from their live SQLite stores
rather than copied into `<sessions>/`. The OpenCode and Kilo Code defaults are
`~/.local/share/opencode/opencode.db` and `~/.local/share/kilo/kilo.db`.

Agentmine resolves the current Goose runtime location first and keeps its documented macOS location
as a compatibility fallback:

- A non-empty `GOOSE_PATH_ROOT` takes precedence and resolves to
  `<root>/data/sessions/sessions.db`. Goose documents this override as an absolute path.
- macOS/Linux: `$XDG_DATA_HOME/goose/sessions/sessions.db` when `XDG_DATA_HOME` is absolute,
  otherwise `~/.local/share/goose/sessions/sessions.db`.
- macOS compatibility fallback, when it exists:
  `~/Library/Application Support/Block/goose/data/sessions/sessions.db`.
- Windows: `%APPDATA%\Block\goose\data\sessions\sessions.db`.

Agentmine follows Cline's own session-directory override precedence:

1. `CLINE_SESSION_DATA_DIR`.
2. `<CLINE_DATA_DIR>/sessions`.
3. `<CLINE_DIR>/data/sessions`.
4. `~/.cline/data/sessions`.

Empty override values are ignored. Relative non-empty values are preserved, matching Cline; use
absolute paths when running Agentmine from a different working directory.

Pi, Factory Droid, and Mistral Vibe have fixed store locations and no path overrides:

- Pi: `~/.pi/agent/sessions/<cwd-slug>/<timestamp>_<id>.jsonl`, one append-only file per session.
- Factory Droid: `~/.factory/sessions/<cwd-slug>/<id>.jsonl`, with a `<id>.settings.json` sibling
  that carries the model alias and the session token totals.
- Mistral Vibe: `~/.vibe/logs/session/<name>/`, a directory per session holding `messages.jsonl`
  and a `meta.json` sidecar. The `.last_session` pointer directory is not a session.

## Cursor metadata caveat

Cursor transcripts do not currently expose reliable per-session model or token usage metadata.
Agentmine leaves those fields unset for Cursor sessions; token and cost reports only include
sources that provide real usage counters.

## Overriding the database path

```bash
AGENTMINE_DB=/path/to/sessions.db agentmine stats
```

The override names the hot database. Payload archives are derived beside it by replacing the
`.db` suffix with `-raw.db` and `-tools.db`; for example, the command above uses
`/path/to/sessions-raw.db` and `/path/to/sessions-tools.db`. Treat all three files as one corpus.
`agentmine backup` snapshots the hot database and every existing sibling archive into one tarball.
