# AGENTS.md

Agentmine (`agentmine`) is a queryable SQLite corpus of an individual
developer's coding-agent sessions (claude-code, codex, opencode, cursor,
gemini, qwen, kilo, goose, cline, copilot, pi, droid, vibe). It ingests session transcript archives,
normalizes to canonical sessions/messages/tool-calls, populates fact + pattern
tables, and exposes
them as an agent-friendly JSON CLI.

This file is the canonical agent brief. Humans should also read
[README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick commands

```bash
pnpm install                       # one-time
pnpm build                         # compile src/ to dist/ (cli keeps node shebang)
pnpm test                          # synthetic-session extractor tests
pnpm test:artifact                 # build, pack, and load the npm artifact
pnpm typecheck                     # strict TS
pnpm lint                          # tsc --noEmit + biome check (format + lint)
pnpm lint:fix                      # biome check --write (auto-format + safe fixes)
pnpm --silent benchmark:cold-import # local cold-normalize harness; flags: ARCHITECTURE.md

node dist/cli.js stats             # corpus overview
node dist/cli.js sessions --root-only --since 1d # list top-level sessions, excluding child workers/reviewers
node dist/cli.js sessions --parent '<session-id>' # list one session's direct children
node dist/cli.js query "SELECT …"  # read-only SQL (SELECT/WITH/EXPLAIN)
node dist/cli.js similar "task description" # find prior sessions solving similar work
node dist/cli.js similar "today's task" --root-only --since 1d # exclude child reviewers + old work
node dist/cli.js session <id> --turn-range 10:20 # inspect a compact slice
node dist/cli.js schema            # inspect envelope schema, exit codes, and command registry
node dist/cli.js schema --tables   # list database tables and views
node dist/cli.js schema --table messages # inspect one table before writing SQL
node dist/cli.js backup            # snapshot the complete SQLite corpus before forced rebuilds
node dist/cli.js compact --dry-run # plan the payload-archive migration + free-space check
node dist/cli.js compact           # move payload to sibling archives and reclaim space (resumable)
node dist/cli.js top sequences --project '/home/me/repo%' --n 3 # re-aggregate ngrams scoped to a project_path LIKE pattern
node dist/cli.js prices sync         # load model_prices from the vendored LiteLLM snapshot (offline); --online fetches live LiteLLM
node dist/cli.js prices ls            # list the loaded price table (USD per 1M tokens)
node dist/cli.js top tokens --by model # choices: model, project, session, day, source; run `prices sync` first for USD cost
node dist/cli.js ingest            # sync → normalize → extract
node dist/cli.js extract           # incremental: rebuild facts for sessions changed since last run (--force for a full rebuild)
node dist/cli.js normalize --since 1d # incremental: only parse files touched in the last day (mtime-filtered walk)
node dist/cli.js embed --provider ollama --model nomic-embed-text --dry-run # local semantic index plan
node dist/cli.js workflows --sort tokens # list Claude Code workflow runs (rank by started|tokens|duration|agents|name)
node dist/cli.js workflow <run_id>    # one run: rollups, ordered phases, per-agent rows (phase, state, tokens, result)
```

`alias agentmine="node $PWD/dist/cli.js"` after build.

## Code layout

| Path | Purpose |
|---|---|
| `src/adapters/` | Consumption seam over the shared `agent-canonical` parsers: `canonical.ts` (flatten + legacy-shape wrappers returning `CanonicalSession \| null`), `types.ts` (the flat corpus shape), and `workflowRaw.ts` (lossless raw ingest of Claude Code workflow manifests/journals into the raw workflow tables). Per-CLI format knowledge lives in the `agent-canonical` package (`src/parsers/`) — never re-implement it here. |
| `src/extract/` | Idempotent fact + pattern extractors (`files.ts`, `shell.ts`, `search.ts`, `web.ts`, `todos.ts`, etc). Registered in `extract/index.ts`. |
| `src/db/` | SQLite client, schema, schemaText (bundled copy), and `sqlite.ts` — the runtime-native compatibility seam over `node:sqlite` for npm/Node and `bun:sqlite` for standalone executables. `schema.sql` is the source of truth. |
| `src/commands/` | One file per CLI subcommand. Wraps `runCommand({ command, handler })` from `contract/result.ts`. |
| `src/contract/` | Result envelope + error catalogue. |
| `src/cli.ts` / `src/main.ts` | Early warning-filter bootstrap / command graph and registration. |
| `src/config.ts` | Resolves DB / archive paths + extension config (`~/.config/agentmine/extensions.js`). |
| `pnpm-lock.yaml` | Standalone public dependency graph used by CI and npm publishing. Keep it frozen and update it with `package.json`. |

## Hard rules

- **Naming:** Use **Agentmine** for the product/tool in prose, including
  sentence starts and headings. Use `agentmine` for the executable,
  package name, command examples, env/config prefixes, and code literals.
  First mention should be **Agentmine** (`agentmine`).
- **DB writes are explicit CLI operations.** `agentmine query` opens with
  SQLite `readonly` flag; only `SELECT`, `WITH`, `EXPLAIN`, and allowlisted
  read-only introspection `PRAGMA`s accepted. The pragma pattern is anchored
  and rejects the assignment form; the SELECT path deliberately has no
  statement-chaining scanner, because `prepare()` compiles only the first
  statement and a `;` inside a literal is data, not a terminator.
  Commands that mutate local state must be idempotent and emit JSON receipts.
  `embed --dry-run` must not write chunks, vectors, or run receipts.
- **A rejection names its recovery.** On the agent-facing read surface
  (`query`, `fts`, `session`, and the shared `openDb` refusal) the strict
  reading runs first and unchanged; only after it fails may the command retry
  one *unambiguous* interpretation, and a result that came from one carries a
  warning naming the substitution (`QUERY_SANITIZED`, `SESSION_ID_RESOLVED`).
  Every actionable rejection names the command that resolves it. Contract:
  `guide/reference/agent-contract.md`.
- **Corpus operations serialize across processes.** Corpus mutations (`normalize`,
  `extract`, `embed`, `prices sync`, `compact`, and `purge --yes`) and the
  consistency-sensitive `backup` command use `withWriteLock` (`src/db/lock.ts`),
  an advisory lock at `${db}.lock`. A held lock waits up to
  `$AGENTMINE_LOCK_TIMEOUT_MS` (default 60s) then fails with a retryable `LOCKED`;
  a stale lock is reclaimed only when its PID is dead on this host. Dry-run paths
  write nothing and skip the lock. Any new corpus write path must use the lock.
- **Schema drift is forbidden.** `src/db/schema.sql` is canonical;
  `src/db/schemaText.ts` is its bundled copy. Edit both, in the same
  commit. If the change is breaking, bump `SCHEMA_VERSION` in
  `src/db/client.ts`.
- **A derivation change is a schema change.** `CURRENT_SCHEMA_VERSION`
  covers what stored values MEAN, not just the column layout: change how a fact is
  derived and every existing row disagrees with the code reading it, while nothing
  else notices — the version gate only refuses an OLD binary on a NEW corpus, and
  freshness only tracks "normalized but not yet extracted", so the corpus reports
  `facts_current: true` over stale rows and a running daemon keeps writing more.
  So bump the version AND add a migration in `applyDataMigrations` invalidating the
  least that forces re-derivation (usually just `deleteMeta(EXTRACT_READY_META_KEY)`,
  which makes the next ordinary `extract` rebuild — do NOT null `content_hash` for an
  extract-side change, that re-parses the whole corpus to produce identical rows).
  The same bump makes a stale daemon stand down. Keep source-specific guards INSIDE
  their own blocks: a guard at the top of `applyDataMigrations` skips every later
  migration for corpora lacking that source.
- **Lossless ingest is intentional.** Adapters should preserve raw source
  events and full untruncated tool output when the source provides it. Keep
  previews in `tool_calls` bounded for browsing, but do not throw away
  analyzable raw data during normalize.
- **Shell-derived facts come from a parse, never a match.** `shell_commands.cmd_full`
  is stored WHOLE (no cap) and redacted on the way in — `tool_calls.args_json` is
  not redacted at normalize time, only the previews are. Extractors over it go
  through `extract/shellParse.ts` (the `unbash` shell parser): a row may only be
  attributed to a parsed command node whose command word is the tool, so text in a
  quoted argument or heredoc body never becomes a fact. Any parse error means NO rows
  for that command — a fact table would rather be missing a row than carry a wrong
  one. That policy only holds because the text is complete: a 500-char cap here used
  to make ~17% of commands unparseable and silently erase their facts. Scope is
  top-level plus `&&`/`||`/`;`/`|`; subshells, loop/conditional bodies, and `$( )` are
  deliberately not walked (widening also reaches heredoc bodies — validate before
  changing), so a script that is only a `for` loop has NO `cmd_head`: a shell keyword
  is not a command. `cmd_head` is that same parse's first command word, skipping
  statements that carry none (`WT=/path` on its own line), and it gates `git.ts` —
  losing a head loses that command's git ops too. A session-level fact belongs to the
  fact table, not the text: `ended_with_commit` reads `git_operations`, because
  `cmd_full LIKE '%git commit%'` let a later `grep -rn "git commit"` overwrite a real
  commit. Changing derivation does not fix stored rows; that needs `extract --force`.
- **Cold payload lives in sibling archives, not `sessions.db`.** `raw_events` and
  `tool_outputs` are in `sessions-raw.db` / `sessions-tools.db`, stored
  zstd-compressed as BLOBs, attached on demand via `db/archives.ts` and read
  through `decodePayload`. Rules that follow from that:
  - **Never assume one database.** A command that needs payload must
    `attachArchive`; a command that does not must never attach, so its cost
    stays bounded by the hot database. `stats` reads payload totals from the
    `sessions.raw_event_count` / `tool_output_count` counters instead.
  - **Payload is not SQL-searchable.** It is compressed binary, so `LIKE` and
    `json_extract` no longer reach it. Recover anything you need from parsed
    events at normalize time (as `writeSkillsAvailable` does) rather than by
    scanning payload later.
  - **Pre-0.9 corpora fail closed.** The common `openDb` gate rejects the
    single-database payload layout for every normal corpus command. Only
    discovery that does not open a corpus plus `backup` and `compact` may run
    before the explicit migration. Filesystem-only workflows such as `sync`
    and `ingest` call `assertConfiguredCorpusReady` before their first write.
  - **Write cold-first.** Cross-database transactions are NOT atomic under
    WAL. `writeSessionPayload` must commit before `upsertSession`; deletes go
    hot-first. Orphaned archive rows are valid and self-heal; a hot row with
    missing payload is not. Single-session callers should use
    `upsertSessionWithPayload`, which orders both phases correctly.
  - `agentmine compact` migrates a pre-split corpus. `normalize` refuses to
    run until it has.
- **agent-canonical parser style is the adapter contract.** Per-CLI
  format knowledge lives in the `agent-canonical` package
  (`src/parsers/<cli>/`), not in Agentmine. New or changed codecs should follow the layered
  pipeline: `unknown` raw input → permissive Zod wire schemas (`safeParse`,
  no `as`) → typed decoded unions/records → pure reducer → canonical
  `Session` → `ParseResult<T>` with accumulated issues. Keep IO in
  `index.ts`/`shells.ts`, keep reducers free of filesystem/DB access, and
  treat malformed rows/lines as warnings unless the session cannot be built.
  Wire schemas should declare only fields consumed and use `.passthrough()`
  for unstable stores; canonical schemas stay stable and strict.
- **Extractors are idempotent and incremental.** Pattern: `DELETE FROM
  <table> WHERE session_id IN (…)` then `INSERT`. Inside one transaction.
  `extract` rebuilds only the sessions a preceding `normalize` marked in
  `dirty_sessions`; use `scopedDelete` + `scopeAnd`/`scopeWhere` from
  `extract/scope.ts` so a scoped rebuild equals a full one (`extract --force`
  ignores the dirty set and rebuilds the whole corpus). Corpus-aggregate
  extractors (subagents/ngrams/templates + the subagent-count rollup) ignore
  the scope and always rebuild — keep them cheap. Re-running `extract` on an
  unchanged corpus must be a no-op.
- **Fact freshness is explicit.** `dirty_sessions` plus the durable workflow
  pending marker are authoritative for whether normalized inputs still need
  extraction. Any browse command or mode that reads extract-owned fact or
  pattern tables, or exposes extract-maintained fields, must reuse
  `db/freshness.ts` and emit its `EXTRACTION_PENDING` warning; never infer
  freshness from content dates or silently run a writer from a read command.
- **Normalize is content-hash cached, with a stat pre-filter.** The
  content hash (`sessionIsUpToDate`) is the source of truth for "did this
  session change". On top of it, `file_stat_cache` records each file's
  `(mtime, size)` so an unchanged re-run skips the parse+hash entirely
  instead of parsing just to rediscover a cache hit — folding in freshness
  siblings (Cline metadata, Droid settings, Vibe `meta.json`) so a sibling-only
  change still re-parses.
  `--force` ignores both caches; `--dry-run` uses neither. Don't bypass
  the cache.
- **The public dist manifest is mirror-generated.** `dist-manifest.json` exists only in the
  standalone public projection. Never hand-edit or copy it into this package source. The mirror
  builds with the frozen standalone lock and writes the metadata-free reviewed artifact manifest;
  CI and publishing must verify the final rebuilt/packed `dist/` against it.
- **Standalone targets are explicit and complete.** Build only `bun-linux-x64-baseline`,
  `bun-darwin-x64`, or `bun-darwin-arm64` through `scripts/build-standalone.mjs`. Native parity,
  executable scanning, archive verification, and the complete release manifest must pass before
  npm publication. Binary scanner exceptions must bind the exact target, detector, decoder,
  verification state, raw-value SHA-256, byte length, and occurrence count; never exclude a whole
  detector or print matched bytes.
- **JSON envelope is the contract.** Every command emits one JSON
  line on stdout matching the shape in `guide/reference/agent-contract.md`.
  Progress goes to stderr as NDJSON.
- **No LLM calls in the default `sync → normalize → extract` path.**
  Local embedding features live behind explicit `embed` and `similar`
  commands. Override the Ollama endpoint with
  `AGENTMINE_OLLAMA_BASE_URL`.
- **Local embeddings are optional.** `agentmine embed --provider ollama`
  writes `embedding_*` tables only after an explicit non-dry-run command.
  Scope a run to recent work with `--since` (ISO date, `YYYY-MM-DD`, or a
  relative offset like `7d`/`2w`/`12h`) — it filters both the planning and
  the pending-chunk queries by `sessions.started_at`, so only chunks from
  sessions in the window get embedded (e.g. `embed --since 7d` to index
  just the last week).
  Bare `agentmine similar` runs in `auto` mode: it selects hybrid only
  when a local embedding index exists, current-session exclusion is
  active, and project scope is available; otherwise it falls back to FTS
  and reports the reason in `mode_selection`. Explicit semantic retrieval
  remains available with `--mode embedding` or `--mode hybrid`.

## Adding things

- **New adapter:** add the parser to the `agent-canonical` package
  (`src/parsers/<cli>/` — layered: `events.ts`/`records.ts`
  decoder + `reduce.ts` + `parseSessionFile`, Result-with-issues),
  including `rawEvents` and `ToolCall.outputFull` where available; then add a
  flatten wrapper in `src/adapters/canonical.ts` and register it in
  `commands/normalize.ts` behind a `source` switch. For a file-backed source,
  also add its resolved source + mirror paths in `src/config.ts`, a `sync`
  target, public path/CLI docs, and a source-specific `ingest` workflow test.
- **New extractor:** new file in `src/extract/` exporting
  `extract<Thing>(db, scope)`, idempotent scoped DELETE+INSERT (see
  `extract/scope.ts`), register in `extract/index.ts`. Add a synthetic-session
  test in `tests/`.
- **New browse command:** new file in `src/commands/`, use
  `runCommand({ command, handler })`, register in `main.ts`, **and declare it in
  the agent-discovery manifest in `commands/schema.ts`** with its
  `readOnlyHint` / `destructiveHint` / `idempotentHint` annotations. The
  manifest is not optional and not cosmetic: `tests/smoke.test.ts` and
  `tests/distSmoke.test.ts` assert it matches `--help` exactly, and a missing
  entry fails as `expected [...] to deeply equal [Array(N)]` — which names
  neither the command nor the manifest. A long-running command keeps the same
  contract: JSON envelope on stdout, NDJSON progress on stderr.
- **New embedding behavior:** keep `embed` agent-first: JSON stdout,
  NDJSON progress on stderr, dry-run first, bounded `--limit`, and
  source/project filters on semantic `similar`.
- **New table / column:** edit `src/db/schema.sql` *and* mirror it
  in `src/db/schemaText.ts`. Bump `SCHEMA_VERSION` if breaking.

## Test data

- Test fixtures live at `tests/fixtures/<source>/`.
- Synthetic sessions are constructed inline in extractor tests (see
  `tests/extract.test.ts`).
- `pnpm test` runs the default suite (the Ollama E2E is skipped unless
  opted in). `pnpm test:ollama` runs the real local `nomic-embed-text`
  regression when Ollama is installed and the model is pulled.

## Don'ts

- Don't write canonical session, message, or tool-call rows outside
  `db/writer.ts`. Maintenance and derived-data commands may write only the
  tables they own, under `withWriteLock`, while preserving the archive ordering
  above. One-off scripts must use the same boundaries or a separate file.
- Don't add commands that emit non-JSON to stdout. Pretty output is
  optional and only when stdout is a TTY.
- Don't document real local archive names, host suffixes, usernames, or
  absolute private paths in committed examples. Use placeholders such as
  `~/claude-history-YYYYMMDD.tar.gz`.
- Don't extend the `error_category` / correction `kind` / friction
  `type` enums without also updating the matching extractor and a
  test fixture.
- Don't fabricate session IDs, `cmd_full` strings, or numbers in
  documentation. Every quoted figure in research output must be
  paste-from-query.
- Don't commit `~/.config/agentmine/extensions.js` content — it is
  user-private by design.
- Don't run `extract` from a stale `dist/`. After `normalize --force`
  or a schema rebuild the fact tables are emptied and only repopulate
  on `extract` — and `extract` must run from a CURRENT build. A `dist`
  built before a table existed runs `extract` to success while silently
  omitting the newer table: e.g. `skills_available` stays at 0 rows and
  is absent from the receipt, with no error. If any fact table is
  unexpectedly empty, `pnpm build` then re-run `extract` before
  trusting a count. (`skills_available` is the exception: it is written by
  `normalize` from parsed events, not by `extract`, so `extract` only reports
  its row count.)
