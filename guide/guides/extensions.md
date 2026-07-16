---
title: Extensions
description: Add custom adapters or redaction rules to Agentmine without forking it.
---

**Agentmine** supports a local extension file for adding custom sources or redaction rules without
changing the Agentmine repository itself.

## Extension file

Create `~/.config/agentmine/extensions.js`:

```js
export default {
  adapters: [],
  redactPatterns: [
    { name: "custom-token", pattern: /CUSTOM_TOKEN_[A-Z0-9]+/g },
  ],
};
```

- `adapters` — additional source adapters beyond the built-in Claude Code, Cursor, Codex, Gemini
  CLI, Qwen Code, Cline, Kilo Code, Goose, and opencode ones.
- `redactPatterns` — extra redaction rules applied alongside the built-in secret patterns.

## Keep it private

Extension files are user-private and should not be committed.
