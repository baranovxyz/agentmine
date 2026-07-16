import { describe, expect, it } from "vitest";
import {
  parseProjectPathAllow,
  projectPathMatchesAllow,
} from "../src/projectPathFilter.js";

describe("project path allow filter", () => {
  it("parses comma-separated substrings", () => {
    expect(parseProjectPathAllow(" allowed-project, other-repo ")).toEqual({
      raw: "allowed-project, other-repo",
      patterns: ["allowed-project", "other-repo"],
    });
  });

  it("matches project_path by substring and skips null paths", () => {
    const filter = parseProjectPathAllow("allowed-project");

    expect(
      projectPathMatchesAllow("/workspace/allowed-project/app", filter),
    ).toBe(true);
    expect(projectPathMatchesAllow("/workspace/unrelated/app", filter)).toBe(
      false,
    );
    expect(projectPathMatchesAllow(null, filter)).toBe(false);
  });

  it("preserves current behavior when unset", () => {
    expect(projectPathMatchesAllow(null, null)).toBe(true);
    expect(projectPathMatchesAllow("/any/project", null)).toBe(true);
  });
});
