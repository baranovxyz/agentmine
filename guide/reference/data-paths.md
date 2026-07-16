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
| `<sessions>/opencode/` | legacy file-based opencode archives, when present |
| `<sessions>/sessions.db` | SQLite corpus |
| `<sessions>/backups/` | backup archives |

Current opencode, Kilo Code, and Goose sessions are read directly from their live SQLite stores
rather than copied into `<sessions>/`. The opencode and Kilo Code defaults are
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

## Cursor metadata caveat

Cursor transcripts do not currently expose reliable per-session model or token usage metadata.
Agentmine leaves those fields unset for Cursor sessions; token and cost reports only include
sources that provide real usage counters.

## Overriding the database path

```bash
AGENTMINE_DB=/path/to/sessions.db agentmine stats
```
