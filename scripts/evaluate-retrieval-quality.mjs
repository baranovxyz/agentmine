#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cli = process.env.AGENTMINE_CLI ?? resolve(repoRoot, "dist", "cli.js");
const provider = process.env.AGENTMINE_EVAL_PROVIDER ?? "ollama";
const model = process.env.AGENTMINE_EVAL_MODEL ?? "nomic-embed-text";
const limit = process.env.AGENTMINE_EVAL_LIMIT ?? "5";

const defaultQueries = [
  [1, "local embeddings ollama provider fake provider hybrid retrieval"],
  [2, "sqlite schema.sql schemaText migration schema drift bundled schema version"],
  [3, "agent first cli json stdout stderr dry run no prompts semantic exit codes schema discovery"],
  [4, "cursor transcript adapter subagent parent session linkage"],
  [5, "opencode sqlite database adapter read live WAL readonly"],
  [6, "redaction false positive sk token y1 oauth cursor paths"],
  [7, "extractor idempotent delete insert transaction fact tables"],
  [8, "tool call ngrams recurring grep glob search patterns"],
  [9, "user corrections classifier reject undo factual style pivot"],
  [10, "self resolutions failed command then successful retry no user turn"],
  [11, "React router auth redirect loop loader return URL session"],
  [12, "Next.js server actions form validation optimistic update error boundary"],
  [13, "TypeScript strict null checks discriminated union exhaustive switch"],
  [14, "SQLite WAL readonly database busy better-sqlite3 transaction lock"],
  [15, "pnpm workspace package build tsc ESM Node 22 shebang"],
  [16, "Vitest flaky async test timeout event based wait race condition"],
  [17, "Cursor browser MCP snapshot click ref stale iframe blocker", { source: "cursor" }],
  [18, "Figma design implementation tokens auto layout screenshot mismatch"],
  [19, "Claude Code hook PreToolUse block dangerous git command", { source: "claude-code" }],
  [20, "MCP server tool schema descriptor mcp_auth CallMcpTool arguments"],
  [21, "monorepo checkout collision reserved worktree CLI"],
  [22, "frontend deploy nginx release config agent shell error"],
  [23, "Rails controller model Hotwire Turbo Stimulus coding session"],
  [24, "Python type hints dataclass pydantic error handling retry timeout"],
  [25, "browser test login blocker captcha permission manual takeover"],
  [26, "large markdown JSON stdout truncation jq parse session render"],
  [27, "structured error retryable transient category traceId exit code"],
  [28, "semantic search noisy duplicate sessions source project filters"],
  [29, "agent findings severity file references missing tests"],
  [30, "documentation AGENTS.md CLAUDE.md skill discoverability context"],
  [31, "research continuation scratch gitignore archive durable outputs"],
  [32, "missing artifacts MoSCoW falsification candidates research proposal"],
  [33, "corpus exploration hypothesis SQL verdict README queries log"],
  [34, "tool result missing output exit_code Cursor limitations workaround", { source: "cursor" }],
  [35, "custom CLI session idPrefix source parser extension normalization", { source: "custom-cli" }],
  [36, "secret redaction yandex oauth bearer token false positive filepath"],
  [37, "negative control unrelated vague query banana recipe vacation itinerary"],
];

const queries = loadQueries();

function loadQueries() {
  const raw = process.env.AGENTMINE_EVAL_QUERIES_JSON;
  if (!raw) return defaultQueries;

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("AGENTMINE_EVAL_QUERIES_JSON must be a JSON array");
  }
  return parsed;
}

function runSimilar(query, options = {}, mode = "fts", allProjects = false) {
  const args = [cli, "similar", query, "--limit", limit];
  if (mode === "embedding" || mode === "hybrid") {
    args.push("--mode", mode, "--provider", provider, "--model", model);
  } else if (mode === "fts") {
    args.push("--mode", "fts");
  }
  if (allProjects) {
    args.push("--all-projects");
  } else {
    if (options.project) args.push("--project", options.project);
    if (options.source) args.push("--source", options.source);
  }

  const env = { ...process.env };
  if (options.currentSession) env.AGENTMINE_CURRENT_SESSION_ID = options.currentSession;

  const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : repoRoot;
  const stdout = execFileSync("node", args, { cwd, env, encoding: "utf8", maxBuffer: 16_000_000 });
  return JSON.parse(stdout).data;
}

const results = [];
for (const [n, query, options = {}] of queries) {
  const auto = runSimilar(query, options, "auto");
  const fts = runSimilar(query, options, "fts");
  const hybrid = runSimilar(query, options, "hybrid");
  const allProjects = options.project || options.cwd ? runSimilar(query, options, "hybrid", true) : null;
  const currentSession = options.currentSession;
  const leaked = currentSession
    ? hybrid.rows.some((row) => row.session_id === currentSession)
    : false;

  results.push({
    q: n,
    query,
    cwd: options.cwd ?? repoRoot,
    source_filter: options.source ?? null,
    project_filter: hybrid.project_filter ?? null,
    excluded_sessions: hybrid.excluded_sessions ?? [],
    warnings: hybrid.warnings ?? [],
    auto_mode: auto.mode,
    auto_fallback_reason: auto.mode_selection?.fallback_reason ?? null,
    auto_fallback_reasons: auto.mode_selection?.fallback_reasons ?? [],
    low_confidence: hybrid.low_confidence === true,
    leaked_current_session: leaked,
    auto_top5: auto.rows.map((row) => row.session_id),
    fts_top5: fts.rows.map((row) => row.session_id),
    hybrid_top5: hybrid.rows.map((row) => row.session_id),
    auto_sources: [...new Set(auto.rows.map((row) => row.source))],
    hybrid_sources: [...new Set(hybrid.rows.map((row) => row.source))],
    all_projects_top5: allProjects?.rows.map((row) => row.session_id) ?? null,
  });
}

const autoFallbackReasons = results.reduce((counts, result) => {
  for (const reason of result.auto_fallback_reasons) {
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}, {});

const summary = {
  query_count: results.length,
  auto_hybrid_count: results.filter((result) => result.auto_mode === "hybrid").length,
  auto_fts_count: results.filter((result) => result.auto_mode === "fts").length,
  auto_fallback_reasons: autoFallbackReasons,
  low_confidence_count: results.filter((result) => result.low_confidence).length,
  leakage_count: results.filter((result) => result.leaked_current_session).length,
  missing_exclusion_warning_count: results.filter((result) =>
    result.warnings.includes("missing_current_session_exclusion"),
  ).length,
};

console.log(JSON.stringify({ summary, results }, null, 2));
