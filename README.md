# Agentmine

Agentmine turns local AI coding-agent session transcript archives into a
queryable SQLite corpus.

It ingests session transcripts from tools such as Claude Code, Cursor, Codex, Gemini CLI, Qwen
Code, Kilo Code, Goose, Cline, and opencode, normalizes them into a shared schema, extracts useful
facts, and exposes the result through an agent-friendly JSON CLI.

Use it to answer questions like:

- What files and commands do my agents touch most?
- Which failed commands or tool errors repeat?
- What corrections do I keep giving agents?
- Have I solved a similar task before?
- Which skills, MCP tools, or agent workflows are actually used?
- Which sessions were user-facing roots, delegated workers, nested workers, or automatic reviews?

Agentmine is local-first. It reads local transcript stores and writes local
SQLite data under the user data directory by default. It does not call an LLM
in the default `sync -> normalize -> extract` path.

Full documentation: **[agentmine.io](https://agentmine.io)**.

## Status

Agentmine is under active development. The core local corpus workflow is working
and covered by tests. The README is intentionally concise; the full guide lives in
[`guide/`](guide/) and at [agentmine.io](https://agentmine.io).

## Requirements

- Node.js 24+
- macOS or Linux; Windows users can run Agentmine in WSL
- `rsync` for transcript sync and `tar` for backup/history imports
- pnpm, when building from source
- SQLite via Node's built-in `node:sqlite` (no native build / prebuilt binary)

Optional:

- Ollama with `nomic-embed-text` for local semantic search

## Install

Global CLI (requires Node.js 24+):

```bash
npm i -g agentmine
```

Or from source:

```bash
pnpm install
pnpm build
alias agentmine="node $PWD/dist/cli.js"
```

## Quick Start

Choose the source you have installed:

```bash
# Claude Code, Cursor, Codex, Gemini CLI, Qwen Code, or Cline (pick one)
agentmine ingest --source claude-code
agentmine ingest --source cursor
agentmine ingest --source codex
agentmine ingest --source gemini
agentmine ingest --source qwen
agentmine ingest --source cline

# Current opencode SQLite store
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

Run only one of the six source-specific `ingest` examples. An unfiltered `agentmine ingest` imports
every mirrored source and directly reads available opencode, Kilo Code, and Goose databases during
`normalize`, but expects the default Claude Code transcript directory to exist. For one live-DB
source, use its `normalize --source ...` command plus `extract` as shown above.

For Cline, the source directory follows Cline's own override precedence:
`CLINE_SESSION_DATA_DIR`, then `CLINE_DATA_DIR/sessions`, then `CLINE_DIR/data/sessions`, then
`~/.cline/data/sessions`.

After the first import creates `sessions.db`, run `agentmine backup` before forced rebuilds or
other destructive maintenance.

See [Getting started](guide/getting-started.md) for incremental imports, the
project-path allowlist, and database-path overrides.

## Documentation

The docs are single-sourced from this repository's [`guide/`](guide/) directory
and published at [agentmine.io](https://agentmine.io):

- [Overview](guide/overview.md) — what Agentmine is and how it fits together.
- [Getting started](guide/getting-started.md) — install, first run, incremental
  imports, and the project-path allowlist.
- [The pipeline](guide/guides/pipeline.md) — how `sync → normalize → extract`
  works and why every step is safe to rerun.
- [Similarity search](guide/guides/similarity-search.md) — `agentmine similar`
  and optional local embeddings.
- [Redaction & privacy](guide/guides/redaction.md) — searchable-text redaction and sensitive
  lossless records.
- [Extensions](guide/guides/extensions.md) — custom sources and redaction rules.
- [CLI command overview](guide/reference/cli.md) ·
  [Data paths](guide/reference/data-paths.md) ·
  [Agent CLI contract](guide/reference/agent-contract.md)
- [Architecture](https://github.com/baranovxyz/agentmine/blob/main/ARCHITECTURE.md) — internals
  and module contracts.

## Development

```bash
pnpm typecheck
pnpm test
```

## License

MIT. See [LICENSE](LICENSE).
