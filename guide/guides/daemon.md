---
title: Keeping the corpus current
description: How the Agentmine daemon imports sessions continuously, how to supervise it, and which installs upgrade cleanly.
---

**Agentmine** can run the ingest pipeline for you, continuously, instead of waiting to be asked.
`agentmine daemon` watches the local session stores and imports what moved, so a query reflects what
your agents were doing seconds ago rather than whenever you last ran [`ingest`](pipeline.md).

```bash
agentmine daemon                          # every installed CLI
agentmine daemon --only claude-code,codex # just these
agentmine daemon --no-extract             # import sessions, skip fact tables
```

It runs in the foreground and streams progress on stderr, one JSON object per event.

## What it costs, and why

How quickly a change is picked up depends on how recently that file was last written. Sessions are
append-only and then frozen — a finished session never changes again — so the daemon rescans
recently-written files every couple of seconds, week-old ones every few minutes, and everything
older about hourly. A file that does change moves back to the fast group immediately, and
directories are checked separately, so a session started in a project you have not touched for
months is still found.

The result is that its cost tracks how much you are working, not how much history you have
accumulated: a corpus that has doubled in size, with no change in daily activity, costs the same per
cycle. Extraction of fact tables runs on a slower cadence of its own, since it is the expensive
stage.

Only one daemon may run against a corpus at a time; a second exits with a `LOCKED` error rather than
duplicating the work. It also records its own liveness in the corpus, so a daemon that has stopped
importing can be told apart from a machine with nothing to import.

## Running it as a service

To keep it running across logouts and reboots, generate a service definition for your platform — a
systemd user unit on Linux, a launchd agent on macOS:

```bash
agentmine daemon --print-service              # show it, write nothing
agentmine daemon --install-service            # write it, print how to enable
agentmine daemon --install-service --only codex --no-extract
```

Any tuning flags you pass are baked into the generated command, so the supervised daemon runs the
configuration you asked for.

Installing writes the file and stops there: the returned `enable` commands are yours to run, so
nothing is enrolled into your init system without you doing it. On Linux that includes
`loginctl enable-linger`, without which a user service stops at logout and the corpus goes stale
exactly when the machine is idle enough to catch up. The `disable` commands in the same result undo
it, ending by deleting the definition.

Once a definition is installed, Agentmine holds the machine to it: read commands warn with
`DAEMON_NOT_RUNNING` when a corpus that is supposed to be continuously fed has not been imported to
within the slowest detection bound. Remove the definition to stop reporting it.

## Which program gets supervised

A service definition names one program by absolute path, permanently. So Agentmine refuses to
generate one for a program that may not survive — inside a checkout, reached by a link into one,
under your temporary directory, or absent outright — because the result is a service that fails
silently while the corpus stops advancing. Install Agentmine globally, or put a standalone
executable on your `PATH`, and generate the definition from that. To supervise a development build
anyway, pass `--allow-ephemeral-path`.

The check looks for a version-control repository anywhere *above* the program, so if you keep your
home directory under git, every install path inside it is refused on those grounds.
`--allow-ephemeral-path` is the answer there too.

## Upgrades

A running daemon keeps the version it started with, and no package manager restarts a per-user
service. So the daemon watches for its own program being replaced, and for a newer Agentmine having
migrated the corpus, and exits when either happens. A supervised daemon then restarts into the
current version by itself, so upgrading Agentmine never leaves your commands on one version and the
process feeding their corpus on another.

**Which install you supervise decides whether that works.** The daemon notices an upgrade by
watching the program file it was started from, so it only sees one if your installer actually
replaces that file:

| Install | Upgrade behaviour |
|---|---|
| `npm install -g agentmine` | Detected. The package directory is replaced in place. |
| A standalone executable you overwrite | Detected. One file, one path. |
| `pnpm add -g agentmine` | **Not detected.** |

pnpm stores each version in its own directory, repoints the launcher at the new one, and leaves the
old directory behind — so nothing the running daemon can observe ever changes, and it keeps serving
the version it started with while your commands report the new one. If you install with pnpm,
restart the service yourself after upgrading
(`systemctl --user restart agentmine-daemon.service`), or supervise a standalone executable instead.

## When something looks wrong

- **Is it alive?** Check the corpus, not the process table: the daemon records a heartbeat there
  every few seconds, and a wedged daemon that is running but no longer progressing is visible that
  way while `ps` would call it healthy.
- **Reads warn `DAEMON_NOT_RUNNING`.** A definition is installed but nothing has imported within the
  slowest detection bound. Check the service, or remove the definition if you no longer want it.
- **The service restarted on its own.** Expected after an upgrade — the daemon stood down so the
  supervisor could start the new version. The reason is recorded before it exits.
- **A source is missing.** A store that cannot be read is reported rather than skipped silently, and
  one failing source never stops the others.
