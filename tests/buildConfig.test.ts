import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = dirname(__dirname);

function readTripleQuotedArray(section: string, key: string): string[] {
  const match = section.match(
    new RegExp(`^${key} = \\[\\n([\\s\\S]*?)^\\]$`, "mu"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`Missing ${key} array in Gitleaks rule`);
  }
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/u, ""))
    .filter(Boolean)
    .map((line) => {
      if (!line.startsWith("'''") || !line.endsWith("'''")) {
        throw new Error(`Expected a single-line triple-quoted ${key} entry`);
      }
      return line.slice(3, -3);
    });
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const PackageJsonSchema = z.object({
  scripts: z.object({
    build: z.string(),
    "verify:dist-manifest": z.string(),
  }),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

describe("build config", () => {
  // Switched from tsc to tsup so agent-canonical is bundled (noExternal) and
  // available in global-install artifacts.
  it("builds agentmine with tsup (agent-canonical bundled)", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(join(REPO, "package.json"), "utf8"),
    );
    const pkg = PackageJsonSchema.parse(packageJson);

    expect(pkg.scripts.build).toContain("tsup");
    expect(pkg.scripts["verify:dist-manifest"]).toBe(
      "node scripts/verify-dist-manifest.mjs",
    );
    expect(pkg.devDependencies ?? {}).toHaveProperty("tsup");
    // agent-canonical must be pinned to an exact published version — never
    // `workspace:*` or a caret/tilde range — so the standalone public
    // dependency graph is deterministic and publication-safe. Assert the pin
    // shape, not the number, so version bumps don't churn this test.
    expect(pkg.devDependencies ?? {}).toHaveProperty("agent-canonical");
    expect((pkg.devDependencies ?? {})["agent-canonical"]).toMatch(
      /^\d+\.\d+\.\d+$/u,
    );
    expect(existsSync(join(REPO, "tsup.config.ts"))).toBe(true);
  });

  it("pins public CI actions and the TruffleHog installer", () => {
    const workflow = readFileSync(
      join(REPO, ".github/workflows/ci.yml"),
      "utf8",
    );
    const actionRefs = [...workflow.matchAll(/uses: [^@\s]+@([^\s#]+)/gu)].map(
      (match) => match[1],
    );

    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((ref) => /^[0-9a-f]{40}$/u.test(ref ?? ""))).toBe(
      true,
    );
    expect(workflow).toContain(
      "trufflesecurity/trufflehog/a7bdcf95222c4369422764e168fad84fc912f0dc/scripts/install.sh",
    );
    expect(workflow).toContain(
      "c394defeaea8a7c48f828a2051b608a9b19f43f34b891407b66a386c3e2591e2",
    );
    expect(workflow).toContain('sh "$INSTALLER" -b "$RUNNER_TEMP/bin" v3.95.9');
    expect(workflow).not.toContain("trufflehog/main/scripts/install.sh");
    expect(workflow).not.toMatch(/curl[^\n]*\|\s*sh/u);
    expect(workflow).not.toContain(
      'npm_config_manage_package_manager_versions: "false"',
    );
    expect(workflow.match(/- name: Verify selected pnpm major/gu)).toHaveLength(
      2,
    );
    expect(
      workflow.match(
        /^\s+pnpm_args: --config\.manage-package-manager-versions=false$/gmu,
      ),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /^\s+pnpm_args: --pm-on-fail=ignore --config\.manage-package-manager-versions=false$/gmu,
      ),
    ).toHaveLength(1);
    expect(workflow.match(/pnpm \$\{\{ matrix\.pnpm_args \}\}/gu)).toHaveLength(
      5,
    );
    expect(
      workflow.match(/pnpm --config\.manage-package-manager-versions=false/gu),
    ).toHaveLength(5);
    expect(workflow).not.toMatch(
      /- run: pnpm (?:install|build|test(?::artifact)?|verify:dist-manifest)\b/gu,
    );
    expect(
      workflow.indexOf("- run: pnpm ${{ matrix.pnpm_args }} run test\n"),
    ).toBeLessThan(
      workflow.indexOf(
        "- run: pnpm ${{ matrix.pnpm_args }} run verify:dist-manifest\n",
      ),
    );
    expect(
      workflow.indexOf(
        "- run: pnpm ${{ matrix.pnpm_args }} run verify:dist-manifest\n",
      ),
    ).toBeLessThan(workflow.indexOf("- name: Preview npm tarball contents"));
    expect(workflow).toContain("--no-verification --no-update --fail");
    expect(workflow).toContain("--fail --json --log-level=-1");
    expect(workflow).toContain('>"$RUNNER_TEMP/trufflehog-dist.jsonl"');
    expect(workflow).toContain('2>"$RUNNER_TEMP/trufflehog-dist.stderr"');
    expect(workflow).toContain(
      "Built dist contains a secret-like value or the scanner failed",
    );
    expect(workflow).not.toMatch(/cat[^\n]*trufflehog-dist/u);
    expect(workflow).not.toContain("--only-verified");
  });

  it("limits the LiteLLM model-label Gitleaks exception to one rule and path", () => {
    const config = readFileSync(join(REPO, ".gitleaks.toml"), "utf8");
    const ruleHeaders = config.match(/^\[\[rules\]\]$/gmu) ?? [];
    const allowlistHeaders = config.match(/^\[rules\.allowlist\]$/gmu) ?? [];
    expect(ruleHeaders).toHaveLength(1);
    expect(allowlistHeaders).toHaveLength(1);

    const ruleStart = config.indexOf("[[rules]]");
    if (ruleStart === -1) throw new Error("Missing Gitleaks rule");
    const rule = config.slice(ruleStart);

    expect(rule.match(/^id = "generic-api-key"$/gmu)).toHaveLength(1);
    expect(rule).toContain('condition = "AND"');
    expect(rule).toContain('regexTarget = "line"');
    expect(readTripleQuotedArray(rule, "paths")).toEqual([
      "src/prices/litellm\\.ts",
    ]);
    expect(rule).toContain(
      'description = "LiteLLM model-name example, not an API credential"',
    );

    const source = readFileSync(join(REPO, "src/prices/litellm.ts"), "utf8");
    const modelLabelLines = source
      .split("\n")
      .filter((line) => line.includes("LiteLLM key:"));
    expect(modelLabelLines).toHaveLength(1);
    const modelLabelLine = modelLabelLines[0];
    if (modelLabelLine === undefined)
      throw new Error("Missing model-label line");
    const modelLabel = modelLabelLine.trim().replace(/^\*\s*/u, "");
    expect(readTripleQuotedArray(rule, "regexes")).toEqual([
      `^[[:space:]]*\\*[[:space:]]${escapeRegexLiteral(modelLabel)}$`,
    ]);
  });

  it("scopes synthetic redaction allowances to individual fixture lines", () => {
    const config = readFileSync(join(REPO, ".gitleaks.toml"), "utf8");
    expect(config).not.toMatch(/^\[allowlist\]$/mu);

    const source = readFileSync(join(REPO, "tests/redact.test.ts"), "utf8");
    const allowedFixtureLines = source
      .split("\n")
      .filter((line) => line.includes("gitleaks:allow"));
    expect(allowedFixtureLines).toHaveLength(2);
    expect(
      allowedFixtureLines.some((line) => line.includes('redactText("token=')),
    ).toBe(true);
    expect(
      allowedFixtureLines.some((line) => line.includes('"API_TOKEN=')),
    ).toBe(true);
  });

  it("isolates npm OIDC from repository build and verification code", () => {
    const workflow = readFileSync(
      join(REPO, ".github/workflows/publish.yml"),
      "utf8",
    );
    const prepareJob = workflow
      .split("\n  prepare:\n")[1]
      ?.split("\n  publish:\n")[0];
    const publishJob = workflow
      .split("\n  publish:\n")[1]
      ?.split("\n  verify:\n")[0];
    const verifyJob = workflow
      .split("\n  verify:\n")[1]
      ?.split("\n  tag-and-release:\n")[0];
    const releaseJob = workflow.split("\n  tag-and-release:\n")[1];
    if (
      prepareJob === undefined ||
      publishJob === undefined ||
      verifyJob === undefined ||
      releaseJob === undefined
    ) {
      throw new Error("Missing release workflow job");
    }

    expect(prepareJob).toContain(
      `if: \${{ github.repository == 'baranovxyz/agentmine' && github.ref == 'refs/heads/main' }}`,
    );
    expect(prepareJob).not.toContain("id-token: write");
    expect(prepareJob).toContain("pnpm install --frozen-lockfile");
    expect(prepareJob).toContain("pnpm build");
    expect(prepareJob).toContain("pnpm test:artifact");
    expect(prepareJob).toContain("npm pack --ignore-scripts --json");
    expect(prepareJob).toContain(
      "Verify packed dist against reviewed manifest",
    );
    expect(prepareJob).toContain("scripts/verify-dist-manifest.mjs");
    expect(prepareJob).toContain('--package-root "$EXTRACT_DIR/package"');
    expect(prepareJob).toContain(
      '--manifest "$GITHUB_WORKSPACE/dist-manifest.json"',
    );
    expect(prepareJob).toContain("Scan packed dist for secret-like values");
    expect(prepareJob).toContain(
      "trufflesecurity/trufflehog/a7bdcf95222c4369422764e168fad84fc912f0dc/scripts/install.sh",
    );
    expect(prepareJob).toContain(
      "c394defeaea8a7c48f828a2051b608a9b19f43f34b891407b66a386c3e2591e2",
    );
    expect(prepareJob).toContain(
      'sh "$INSTALLER" -b "$RUNNER_TEMP/bin" v3.95.9',
    );
    expect(prepareJob).toContain("--no-verification --no-update --fail");
    expect(prepareJob).toContain("--fail --json --log-level=-1");
    expect(prepareJob).toContain(
      '>"$RUNNER_TEMP/trufflehog-packed-dist.jsonl"',
    );
    expect(prepareJob).toContain(
      '2>"$RUNNER_TEMP/trufflehog-packed-dist.stderr"',
    );
    expect(prepareJob).toContain(
      "Packed dist contains a secret-like value or the scanner failed",
    );
    expect(prepareJob).not.toMatch(/cat[^\n]*trufflehog-packed-dist/u);
    expect(prepareJob).not.toContain("--only-verified");
    expect(prepareJob).not.toMatch(/curl[^\n]*\|\s*sh/u);
    expect(prepareJob).toContain("actions/upload-artifact@");

    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("environment: npm");
    expect(publishJob).toContain("actions: read");
    expect(publishJob).not.toContain("contents: read");
    expect(publishJob).not.toContain("contents: write");
    expect(publishJob).not.toContain("actions/checkout@");
    expect(publishJob).not.toContain("pnpm ");
    expect(publishJob).not.toContain("test:artifact");
    expect(publishJob).not.toContain("npm view");
    expect(publishJob).not.toContain('import { z } from "zod"');
    expect(publishJob).toContain("npm install -g npm@11.17.0 --ignore-scripts");
    expect(publishJob).toContain("actions/download-artifact@");
    expect(publishJob).toContain(
      "downloaded release candidate integrity mismatch",
    );
    expect(publishJob).toContain("release-artifact/agentmine-release.tgz");
    expect(publishJob).not.toContain("needs.prepare.outputs.filename");
    expect(publishJob).not.toContain("npm@latest");

    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toContain("environment: npm");
    expect(verifyJob).toContain("actions/download-artifact@");
    expect(verifyJob).toContain("zod@4.4.3");
    expect(verifyJob).toContain('import { z } from "zod"');
    expect(verifyJob).toContain("dist.attestations.url");
    expect(verifyJob).toContain("https://slsa.dev/provenance/v1");
    expect(verifyJob).toContain("process.env.EXPECTED_SHA");

    const actionRefs = [...workflow.matchAll(/uses: [^@\s]+@([^\s#]+)/gu)].map(
      (match) => match[1],
    );
    expect(actionRefs.length).toBeGreaterThan(0);
    expect(actionRefs.every((ref) => /^[0-9a-f]{40}$/u.test(ref ?? ""))).toBe(
      true,
    );
    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);

    expect(workflow).toContain(
      "Tag $TAG already points at $REMOTE_SHA, expected $GITHUB_SHA",
    );
    expect(workflow).toContain('git tag "$TAG" "$GITHUB_SHA"');
    expect(releaseJob).toContain("needs.verify.result == 'success'");
    expect(workflow.indexOf("- name: Tag preflight")).toBeLessThan(
      workflow.indexOf("- name: Publish (dry run)"),
    );
    expect(workflow.indexOf("pnpm test:artifact")).toBeLessThan(
      workflow.indexOf("- name: Pack release candidate"),
    );
    expect(workflow.indexOf("- name: Pack release candidate")).toBeLessThan(
      workflow.indexOf("- name: Verify packed dist against reviewed manifest"),
    );
    expect(
      workflow.indexOf("- name: Verify packed dist against reviewed manifest"),
    ).toBeLessThan(
      workflow.indexOf("- name: Scan packed dist for secret-like values"),
    );
    expect(
      workflow.indexOf("- name: Scan packed dist for secret-like values"),
    ).toBeLessThan(workflow.indexOf("- name: Upload tested release candidate"));
    expect(workflow).toContain(
      `npm publish "$ARTIFACT" --provenance --access public --ignore-scripts --tag \${{ needs.prepare.outputs.tag }} --dry-run`,
    );
    expect(workflow).toContain(
      `npm publish "$ARTIFACT" --provenance --access public --ignore-scripts --tag \${{ needs.prepare.outputs.tag }}\n`,
    );
    expect(workflow).not.toContain(
      "run: npm publish --provenance --access public",
    );
    expect(workflow).toContain("finalize-only");
    expect(workflow).toContain("id: availability");
    expect(workflow).toContain(
      'echo "already_published=true" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      'echo "already_published=false" >> "$GITHUB_OUTPUT"',
    );
    expect(workflow).toContain(
      "needs.prepare.outputs.already_published != 'true'",
    );
    expect(workflow).toContain(
      "already published; dry-run requires an unpublished version",
    );
    expect(workflow).toContain(
      "skipping publish and requiring exact integrity + provenance verification",
    );
    expect(workflow).toContain(
      'PUBLISHED_INTEGRITY=$(npm view "$PACKAGE" dist.integrity 2>"$RUNNER_TEMP/integrity.err")',
    );
    expect(workflow).toContain("for ATTEMPT in 1 2 3 4 5 6");
    expect(workflow).toContain(
      "registry metadata did not become available after 6 attempts",
    );
    expect(workflow).toContain(
      "SLSA provenance attestation was unavailable after 6 attempts",
    );
    expect(workflow).toContain(
      'workflow.path !== ".github/workflows/publish.yml"',
    );
    expect(workflow).not.toContain(
      'workflow.path !== "/.github/workflows/publish.yml"',
    );
    expect(workflow).toContain("grep -q 'E404'");
    expect(workflow).toContain(
      "Could not determine whether $PACKAGE already exists",
    );
    expect(workflow).not.toContain(
      '|| echo "Release already exists for $TAG, skipping"',
    );
  });
});
