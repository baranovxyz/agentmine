import { describe, expect, it } from "vitest";
import {
  parseSkillListingContent,
  skillNamesMatch,
  slugFromSkillDirectory,
} from "../src/extract/parseSkillListing.js";

describe("parseSkillListingContent", () => {
  it("parses slugs with colons and section origins", () => {
    const content = `### Project
- code-review: Review a change before merge
### Plugin
- superpowers:brainstorming: Explore before coding
- plugin-dev:create-plugin: Build a plugin
`;
    expect(parseSkillListingContent(content)).toEqual([
      {
        skillName: "code-review",
        description: "Review a change before merge",
        origin: "project",
      },
      {
        skillName: "superpowers:brainstorming",
        description: "Explore before coding",
        origin: "plugin",
      },
      {
        skillName: "plugin-dev:create-plugin",
        description: "Build a plugin",
        origin: "plugin",
      },
    ]);
  });
});

describe("skillNamesMatch", () => {
  it("matches scoped catalog names to hook slugs", () => {
    expect(skillNamesMatch("superpowers:brainstorming", "brainstorming")).toBe(
      true,
    );
    expect(skillNamesMatch("brainstorming", "brainstorming")).toBe(true);
    expect(skillNamesMatch("task-cli", "brainstorming")).toBe(false);
  });
});

describe("slugFromSkillDirectory", () => {
  it("extracts slug from hook preamble paths", () => {
    expect(
      slugFromSkillDirectory(
        "/Users/u/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming/SKILL.md",
      ),
    ).toBe("brainstorming");
    expect(
      slugFromSkillDirectory(
        "/Users/u/.claude/plugins/cache/claude-plugins-official/superpowers/5.0.2/skills/brainstorming",
      ),
    ).toBe("brainstorming");
  });
});
