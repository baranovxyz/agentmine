import { describe, expect, it } from "vitest";
import { isInjectedNoise } from "../src/noise.js";

describe("injected message noise", () => {
  it.each([
    "# AGENTS.md instructions\n\n<INSTRUCTIONS>",
    "<skill>\n<name>find-similar-sessions</name>",
    "The following is the Codex agent history whose request action you are assessing.",
    "The following is the Codex agent history added since your last approval assessment.",
    "Base directory for this skill: /tmp/example",
    "This session is being continued from a previous conversation.",
    "<environment_context>\n  <cwd>/tmp/example</cwd>\n</environment_context>",
    "<recommended_plugins>\n  <plugin>example</plugin>\n</recommended_plugins>",
    '<plugin_info kind="matched_installed">\ndisplay_name: Example',
    "<manually_attached_skills>\n  <skill>example</skill>",
    "<agent_transcripts>\n  <transcript>example</transcript>",
    "<subagent_notification>\n  <status>completed</status>",
    "<turn_aborted>The user stopped the prior turn.</turn_aborted>",
    "<timestamp>Thursday, July 23, 2026, 7:00 PM (UTC+3)</timestamp>",
    '<hooks_context description="Runtime hook context">',
    "<user_shell_command>git status</user_shell_command>",
    "<cursor_commands>\n  <command>example</command>",
    "<system-reminder>runtime context</system-reminder>",
  ])("recognizes runtime-injected text: %s", (text) => {
    expect(isInjectedNoise(text)).toBe(true);
  });

  it("keeps authored text that merely discusses injected context", () => {
    expect(
      isInjectedNoise(
        "Investigate why AGENTS.md instructions dominate prior-session search.",
      ),
    ).toBe(false);
  });
});
