---
title: Upgrading
description: How to upgrade each Agentmine install method, when a corpus needs its fact tables rebuilt, and what the daemon needs separately.
---

**Agentmine** (`agentmine`) versions the program and your corpus's derived facts independently.
Upgrading the `agentmine` program is one step. Making sure its fact tables reflect the version now
running is a second, separate step — this page covers both, plus the case where a running
[daemon](daemon.md) supervises a different install than the one you upgraded.

## Upgrade the program

Pick the section for however you installed Agentmine, then confirm the result with
`agentmine --version` (plain semantic version) or `agentmine version` (a JSON envelope with
runtime, target, and source-commit metadata).

### npm global install

```bash
npm i -g agentmine
agentmine --version
```

Re-running the same install command upgrades to the latest published version.

### Standalone executable

Download and verify the new release archive the same way as a first install — see
[Getting started](../getting-started.md) for the full attestation-verification flow — then
overwrite the existing executable at the same path, for example:

```bash
install -m 0755 agentmine "$HOME/.local/bin/agentmine"
agentmine --version
```

### pnpm global install

```bash
pnpm add -g agentmine
agentmine --version
```

If you also run `agentmine daemon` as a service generated from this install, restart it by hand
afterward — pnpm repoints the launcher at the new version without changing the file the daemon is
watching, so it does not notice on its own. See [Keeping the corpus current](daemon.md) for why.

### Built from source

Update the checkout to the release you want, then rebuild:

```bash
pnpm install
pnpm build
agentmine --version
```

## Rebuild fact tables after upgrading

Some releases change how facts are derived from stored data — for example, how a shell command is
parsed into structured facts. Upgrading the program does not retroactively fix rows an earlier
version already wrote; the corpus needs `agentmine extract` to recompute them. Check
[the changelog](https://github.com/baranovxyz/agentmine/blob/main/CHANGELOG.md) — a release that
changes derivation says so explicitly.

### Agentmine 0.11.1 and later: automatic

From 0.11.1, opening a corpus with a newer Agentmine invalidates the stale incremental-extract
marker automatically. The next ordinary `agentmine extract` — no flags, including the one a
scheduled `ingest` or a running `daemon` already runs for you — then rebuilds the affected fact
tables on its own:

```bash
agentmine extract
```

You do not need `--force` on this path.

### Already on exactly 0.11.0: one-time recovery

If your corpus is currently at 0.11.0 — upgraded before 0.11.1 shipped the automatic migration —
its fact tables may already be silently out of date: 0.11.0 changed shell-derived fact extraction
but had no mechanism yet to detect or rebuild rows an earlier version had written. Recover once
with:

```bash
agentmine backup
agentmine extract --force
```

`backup` snapshots the corpus first. `--force` ignores the dirty-session set and rebuilds every
fact table from the whole corpus, rather than only the sessions changed since the last run.
Upgrading straight to 0.11.1 or later does not need this step — the automatic migration covers it.

### The FACTS_FROM_OLDER_VERSION warning

Read commands that depend on fact or pattern tables warn `FACTS_FROM_OLDER_VERSION` when those
tables were built by a different Agentmine version than the one now running. The warning names
`agentmine extract --force` as the recovery — the same command as the one-time 0.11.0 case above.

## The daemon supervises its own install

If you run `agentmine daemon` as a service, upgrading the `agentmine` you type at the terminal does
not necessarily upgrade what the daemon runs: a service definition names one specific program by
path, and that can be a different install from your everyday CLI — for example, an npm global
install for interactive use next to a standalone executable the daemon's service was generated
from. Upgrading the one you use at the terminal leaves the other, and the facts it derives for
newly ingested sessions, on the old logic. See [Keeping the corpus current](daemon.md) for how to
check which program a service definition actually names, which install methods the daemon notices
being replaced, and when it stands down on its own.

## Historical: 0.8.x -> 0.9 storage-split migration

Agentmine 0.9 moved verbatim source events and complete tool output out of the main database into
compressed sibling archives. An existing 0.8.x corpus needs one explicit, one-time migration before
any normal corpus command:

```bash
agentmine compact --dry-run
agentmine compact
```

The migration is resumable and checks available disk space before writing. Agentmine 0.9 and later
refuse normal corpus commands until it completes; `agentmine backup` remains available as the
recovery step before migration.
