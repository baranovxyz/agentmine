---
title: Getting started
description: Install Agentmine and run the first sync, normalize, and extract pipeline.
---

**Agentmine** (`agentmine`) is available as a Node.js package and as a standalone executable. This
page covers installing it and running the first import.

## Requirements

- macOS or Linux; Windows users can run Agentmine in WSL
- `rsync` for transcript sync and `tar` for backup/history imports
- Node.js 24+ for the npm package, or no external runtime for a standalone executable
- pnpm and Bun 1.3.14 only when building both distributions from source
- SQLite through the selected runtime's built-in driver; no third-party native SQLite package

Optional:

- Ollama with `nomic-embed-text` for local semantic search

## Install

Install the published package globally:

```bash
npm i -g agentmine
```

Alternatively, download the matching `linux-x64`, `darwin-x64`, or `darwin-arm64` archive from
[GitHub Releases](https://github.com/baranovxyz/agentmine/releases). The standalone executable
does not require Node.js or a separate Bun installation. The
[README installation steps](https://github.com/baranovxyz/agentmine#install) show how to select
the latest asset and verify its immutable release attestation with GitHub CLI.

Or build from source:

```bash
pnpm install
pnpm build
alias agentmine="node $PWD/dist/cli.js"
```

Verify either installation:

```bash
agentmine --version
agentmine version
```

The first command prints only the semantic version. The second emits a JSON envelope with the
runtime, target, runtime version, and public source commit when available.

## Quick start

Choose the source you have installed:

```bash
# Claude Code, Cursor, Codex, Gemini CLI, Qwen Code, or Cline (pick one)
agentmine ingest --source claude-code
agentmine ingest --source cursor
agentmine ingest --source codex
agentmine ingest --source gemini
agentmine ingest --source qwen
agentmine ingest --source cline

# Current OpenCode SQLite store
agentmine normalize --source opencode-db
agentmine extract

# Current Kilo Code SQLite store
agentmine normalize --source kilo
agentmine extract

# Current Goose SQLite store
agentmine normalize --source goose
agentmine extract

agentmine stats
```

Run only one of the six source-specific `ingest` examples. Each runs
`sync -> normalize -> extract` for that file-based source. An unfiltered `agentmine ingest`
imports all file-backed sources and picks up available OpenCode, Kilo Code, and Goose databases
during `normalize`, but expects the default Claude Code transcript directory to exist. Live SQLite
stores are not `sync` targets; for one live-DB source, run its `normalize --source ...` command plus
`extract` as shown above. See [The pipeline](guides/pipeline.md) for what each stage does and why
the sequence is safe to rerun.

For Cline, the source directory follows Cline's own override precedence:
`CLINE_SESSION_DATA_DIR`, then `CLINE_DATA_DIR/sessions`, then `CLINE_DIR/data/sessions`, then
`~/.cline/data/sessions`. See [Data paths](reference/data-paths.md) for details.

After the first import creates `sessions.db`, run `agentmine backup` before forced rebuilds or
other destructive maintenance.

When Claude Code is in scope, `normalize` also ingests its workflow manifests and journals.
`extract` then derives workflow rollups that you can browse with:

```bash
agentmine workflows --sort tokens
agentmine workflow <run-id>
```

## Incremental imports

To only parse recently touched files from file-backed sources, pass `--since` to `normalize`:

```bash
agentmine normalize --since 1d
agentmine normalize --since 2026-06-01
```

SQLite-backed sources (`opencode-db`, `kilo`, and `goose`) remain eligible because their session
IDs are not filesystem paths and therefore have no modification time to compare.

## Scoping to selected projects

To permanently keep only sessions from selected project paths, set a comma-separated allowlist of
case-sensitive `project_path` substrings before ingest. When the filter is set, sessions with a
null `project_path` are skipped.

```bash
AGENTMINE_PROJECT_PATH_ALLOW=my-workspace agentmine ingest
```

Purge already-ingested sessions outside the same allowlist from the SQLite DB. The first command is
a dry run; pass `--yes` to delete.

```bash
agentmine purge --project-path-allow my-workspace
agentmine purge --project-path-allow my-workspace --yes
```

## Overriding the database path

```bash
AGENTMINE_DB=/path/to/sessions.db agentmine stats
```

## Next steps

- [The pipeline](guides/pipeline.md) explains each stage and why the pipeline is safe to rerun.
- [CLI command overview](reference/cli.md) lists common browse, search, pipeline, and maintenance
  commands.
- [Agent CLI contract](reference/agent-contract.md) describes the JSON envelope and error codes;
  run `agentmine schema` to discover the contract at runtime.

### For coding agents

Agentmine ships a `using-agentmine` skill in the package (`skills/using-agentmine/SKILL.md`, also
referenced from the `agentskills` field in `package.json`). A coding agent working in a repo that
has `agentmine` installed can load it to learn when and how to query prior sessions — for example,
before starting non-trivial work, run `agentmine similar "<task description>"` to check whether you
solved something like it before.

To wire it into Claude Code, Cursor, or another agent so it triggers on its own, see
[Set up the agent skill](guides/agent-skill.md).
