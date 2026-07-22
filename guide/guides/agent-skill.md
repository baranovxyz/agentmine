---
title: Set up the agent skill
description: Wire the bundled using-agentmine skill into Claude Code, Cursor, or any skills-aware coding agent so it queries your session history on its own.
---

Agentmine ships a bundled **agent skill** so a coding agent can discover, on its own, when and how
to query your session history — before starting non-trivial work, when a command keeps failing, or
when you ask "have I done this before". This page shows how to wire it into your agent.

## What ships

Installing the package puts the skill on disk and advertises it two ways:

- **`skills/using-agentmine/SKILL.md`** — a self-contained skill file with a
  `Use this skill when …` trigger and the exact commands to run.
- **The `agentskills` field in `package.json`** — a machine-readable pointer at that file, so
  skills-aware tooling can find it without you hard-coding a path.

After a global install the skill lives at
`$(npm root -g)/agentmine/skills/using-agentmine/SKILL.md`; after a local install it is at
`node_modules/agentmine/skills/using-agentmine/SKILL.md`.

## Claude Code

Claude Code loads skills from `~/.claude/skills/<name>/SKILL.md` (personal, all projects) and
`.claude/skills/<name>/SKILL.md` (one project). Point either at the installed skill.

Personal, across every project — symlink so it tracks package upgrades:

```bash
mkdir -p ~/.claude/skills
ln -s "$(npm root -g)/agentmine/skills/using-agentmine" ~/.claude/skills/using-agentmine
```

Scoped to one project instead:

```bash
mkdir -p .claude/skills
ln -s "$(npm root -g)/agentmine/skills/using-agentmine" .claude/skills/using-agentmine
```

Prefer a copy over a symlink if you want it pinned (re-copy after upgrading Agentmine):

```bash
cp -r "$(npm root -g)/agentmine/skills/using-agentmine" ~/.claude/skills/
```

## Any skills-aware agent

Other agents (Cursor, Copilot, Codex, and so on) each expose their own skill or rules mechanism.
The setup is the same shape: make `using-agentmine/SKILL.md` visible to that agent, either through
its skills directory or by referencing the file from its rules. Tools that understand the
`agentskills` field can resolve the path from the installed package directly. If you already manage
agent configuration with a syncing tool, add the skill once to your canonical
`skills/using-agentmine/` and let it fan out to every tool.

Nothing about the skill is Claude-specific — it is plain Markdown that describes the jobs Agentmine
does and the commands that do them.

## Keep the corpus fresh

The skill assumes your session history is imported. Run `agentmine ingest` (or wire it into a
session-start hook) so the corpus stays current — see [The pipeline](pipeline.md). The skill only
reads; it never imports on its own.

## Verify

Ask your agent something the skill should catch — for example, "have I solved something like this
before?" A wired-up agent will reach for `agentmine similar` (or `agentmine sessions --since`)
instead of guessing. You can confirm the file is discoverable with:

```bash
ls -l ~/.claude/skills/using-agentmine/SKILL.md
```
