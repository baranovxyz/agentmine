import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { runCommand } from "../contract/result.js";
import type { DatabaseType } from "../db/client.js";
import { dbExists, openDb } from "../db/client.js";
import { deserializeVector } from "../embeddings/chunks.js";
import { createEmbeddingProvider } from "../embeddings/providers.js";
import { INJECTED_TEXT_PREFIXES, isInjectedNoise } from "../noise.js";
import { parseSince, parseUntil } from "./_filters.js";

export interface SimilarRow {
  session_id: string;
  source: string;
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
  started_at: number | null;
  turn_count: number | null;
  tool_call_count: number | null;
  score: number;
  matched_turns: number;
  snippets: Array<{ turn: number; role: string; snippet: string }>;
  chunk_id?: number;
  start_turn?: number;
  end_turn?: number;
  snippet?: string;
  fts_score?: number;
  embedding_score?: number;
  reconstruct_command: string;
}

interface MatchRow {
  session_id: string;
  turn: number;
  role: string;
  source: string;
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
  started_at: number | null;
  turn_count: number | null;
  tool_call_count: number | null;
  score: number;
  snippet: string;
}

interface EmbeddingCandidateRow {
  chunk_id: number;
  session_id: string;
  start_turn: number;
  end_turn: number;
  retrieval_text: string;
  text_preview: string | null;
  source_kind: string;
  vector: Buffer;
  vector_norm: number;
  source: string;
  project_path: string | null;
  git_branch: string | null;
  title: string | null;
  started_at: number | null;
  turn_count: number | null;
  tool_call_count: number | null;
}

type RetrievalMode = "fts" | "embedding" | "hybrid";
type RequestedMode = "auto" | RetrievalMode;
type AutoFallbackReason =
  | "missing_current_session_exclusion"
  | "missing_project_scope"
  | "missing_embedding_index"
  | "provider_unavailable";

interface ModeSelection {
  requested: RequestedMode;
  selected: RetrievalMode;
  guardrails: {
    current_session_excluded: boolean;
    project_scoped: boolean;
    embedding_index_found?: boolean;
    provider_available?: boolean;
  };
  fallback_reason?: AutoFallbackReason;
  fallback_reasons?: AutoFallbackReason[];
}

interface SimilarFilters {
  since?: { input: string; epoch: number };
  until?: { input: string; epoch: number };
  rootOnly: boolean;
  includeInjected: boolean;
}

export const similarCommand = defineCommand({
  meta: {
    name: "similar",
    description: "Find prior sessions similar to a task description",
  },
  args: {
    q: {
      type: "positional",
      description: "Task description or problem statement",
      required: true,
    },
    limit: {
      type: "string",
      default: "10",
      description: "Maximum sessions to return",
    },
    source: {
      type: "string",
      description: "Restrict to a source (claude-code|cursor|...)",
    },
    project: { type: "string", description: "Restrict to project_path prefix" },
    since: {
      type: "string",
      description:
        "Only sessions on/after this point (ISO date, YYYY-MM-DD, or relative offset like 7d)",
    },
    until: {
      type: "string",
      description:
        "Only sessions before this point (a bare YYYY-MM-DD includes that whole UTC day)",
    },
    "root-only": {
      type: "boolean",
      default: false,
      description: "Exclude child workers and automatic reviewer sessions",
    },
    "include-injected": {
      type: "boolean",
      default: false,
      description:
        "Include runtime-injected instruction, skill, hook, and approval-review messages",
    },
    role: {
      type: "string",
      description: "Restrict matching turns to one role",
    },
    mode: {
      type: "string",
      default: "auto",
      description: "Retrieval mode: auto|fts|embedding|hybrid",
    },
    provider: {
      type: "string",
      default: "ollama",
      description: "Embedding provider for semantic modes",
    },
    model: {
      type: "string",
      description: "Embedding model for semantic modes",
    },
    "exclude-session": {
      type: "string",
      description: "Comma-separated session IDs to exclude from results",
    },
    "exclude-run-family": {
      type: "string",
      description:
        "Comma-separated session IDs whose parent/child run family should be excluded",
    },
    "all-projects": {
      type: "boolean",
      default: false,
      description: "Disable the default current-project filter",
    },
  },
  async run({ args }) {
    await runCommand<Record<string, unknown>>({
      command: "agentmine similar",
      handler: async () => {
        if (!dbExists()) {
          throw Errors.notFound(
            "sessions.db not found. Run `agentmine sync` + `agentmine normalize` + `agentmine extract` first.",
          );
        }

        const query = String(args.q ?? "").trim();
        if (!query) throw Errors.invalidInput("Empty task description");
        const matchQuery = toFtsQuery(query);
        if (!matchQuery) {
          throw Errors.invalidInput(
            "Task description must contain at least one searchable word",
          );
        }

        const limit = parseLimit(args.limit, 10);
        const requestedMode = parseMode(args.mode);
        const filters = parseSimilarFilters(args);
        const db = openDb({ readonly: true });
        try {
          const explicitProject = args.project
            ? String(args.project)
            : undefined;
          const inferredProject =
            explicitProject || args["all-projects"]
              ? undefined
              : inferCurrentProjectFilter(db, process.cwd());
          const project = explicitProject ?? inferredProject;
          const excludedSessions = resolveExcludedSessions(db, [
            ...parseSessionList(args["exclude-session"]),
            ...parseSessionList(args["exclude-run-family"]),
            ...parseSessionList(process.env.AGENTMINE_CURRENT_SESSION_ID),
            ...parseSessionList(process.env.AGENTMINE_EXCLUDE_SESSION_IDS),
            ...parseSessionList(
              process.env.AGENTMINE_CURRENT_RUN_FAMILY_SESSION_ID,
            ),
          ]);
          const providerName = String(args.provider ?? "ollama");
          const model = String(
            args.model ??
              (providerName === "fake" ? "fake" : "nomic-embed-text"),
          );
          let modeSelection = selectMode(db, {
            requestedMode,
            providerName,
            model,
            source: args.source ? String(args.source) : undefined,
            project,
            excludedSessions,
            filters,
          });
          const mode = modeSelection.selected;
          const ftsRows =
            mode === "embedding"
              ? []
              : findFtsRows(db, {
                  query: matchQuery,
                  limit: Math.max(limit * 20, 50),
                  source: args.source ? String(args.source) : undefined,
                  project,
                  role: args.role ? String(args.role) : undefined,
                  excludeSessions: excludedSessions,
                  filters,
                });

          if (mode === "fts") {
            const grouped = groupMatches(ftsRows);
            const finalized = finalizeRows(query, grouped, limit);
            const warnings = [...finalized.warnings];
            return {
              data: {
                query,
                match_query: matchQuery,
                mode,
                requested_mode: requestedMode,
                mode_selection: modeSelection,
                project_filter: project ?? null,
                project_filter_source: explicitProject
                  ? "explicit"
                  : inferredProject
                    ? "cwd"
                    : null,
                ...searchFilterFields(filters),
                excluded_sessions: excludedSessions,
                ...warningFields(warnings),
                ...confidenceFields(finalized.lowConfidence),
                row_count: finalized.rows.length,
                rows: finalized.rows,
              },
            };
          }

          let embeddingRows: SimilarRow[];
          try {
            embeddingRows = await findEmbeddingRows(db, {
              query,
              providerName,
              model,
              source: args.source ? String(args.source) : undefined,
              project,
              excludeSessions: excludedSessions,
              filters,
            });
          } catch (e) {
            if (requestedMode !== "auto") throw e;
            modeSelection = fallBackToFts(
              modeSelection,
              "provider_unavailable",
            );
            const grouped = groupMatches(ftsRows);
            const finalized = finalizeRows(query, grouped, limit);
            const warnings = [...finalized.warnings];
            return {
              data: {
                query,
                match_query: matchQuery,
                mode: "fts",
                requested_mode: requestedMode,
                mode_selection: modeSelection,
                project_filter: project ?? null,
                project_filter_source: explicitProject
                  ? "explicit"
                  : inferredProject
                    ? "cwd"
                    : null,
                ...searchFilterFields(filters),
                excluded_sessions: excludedSessions,
                ...warningFields(warnings),
                ...confidenceFields(finalized.lowConfidence),
                row_count: finalized.rows.length,
                rows: finalized.rows,
              },
            };
          }
          const rows =
            mode === "embedding"
              ? embeddingRows
              : mergeHybridRows(groupMatches(ftsRows), embeddingRows);
          const finalized = finalizeRows(query, rows, limit);
          const warnings = [
            ...semanticExclusionWarnings(mode, excludedSessions),
            ...finalized.warnings,
          ];

          return {
            data: {
              query,
              match_query: matchQuery,
              mode,
              requested_mode: requestedMode,
              mode_selection: modeSelection,
              provider: providerName,
              model,
              project_filter: project ?? null,
              project_filter_source: explicitProject
                ? "explicit"
                : inferredProject
                  ? "cwd"
                  : null,
              ...searchFilterFields(filters),
              excluded_sessions: excludedSessions,
              ...semanticExclusionFields(mode, excludedSessions),
              ...warningFields(warnings),
              ...confidenceFields(finalized.lowConfidence),
              row_count: finalized.rows.length,
              rows: finalized.rows,
            },
          };
        } catch (e) {
          throw Errors.invalidInput(
            `similar query error: ${(e as Error).message}`,
          );
        } finally {
          db.close();
        }
      },
    });
  },
});

function findFtsRows(
  db: DatabaseType,
  opts: {
    query: string;
    limit: number;
    source?: string;
    project?: string;
    role?: string;
    excludeSessions?: string[];
    filters: SimilarFilters;
  },
): MatchRow[] {
  const clauses = ["messages_fts MATCH ?"];
  const params: unknown[] = [opts.query];
  if (opts.source) {
    clauses.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project) {
    clauses.push(projectPathClause("s.project_path"));
    params.push(...projectPathParams(opts.project));
  }
  if (opts.role) {
    clauses.push("m.role = ?");
    params.push(opts.role);
  }
  addSessionFilterClauses(clauses, params, "s", opts.filters);
  if (!opts.filters.includeInjected) {
    addInjectedTextExclusion(clauses, params, "m.text");
  }
  addExcludedSessionClause(
    clauses,
    params,
    "f.session_id",
    opts.excludeSessions,
  );
  params.push(opts.limit);

  const rows = db
    .prepare(
      `SELECT f.session_id, f.turn, m.role,
              s.source, s.project_path, s.git_branch, s.title,
              s.started_at, s.turn_count, s.tool_call_count,
              bm25(messages_fts) AS score,
              snippet(messages_fts, 2, '[', ']', '...', 18) AS snippet
         FROM messages_fts f
         JOIN messages m ON m.session_id = f.session_id AND m.turn = f.turn
         JOIN sessions s ON s.id = f.session_id
        WHERE ${clauses.join(" AND ")}
        ORDER BY score
        LIMIT ?`,
    )
    .all(...params) as MatchRow[];
  return rows.map((row) => ({
    ...row,
    title: visibleTitle(row.title, opts.filters.includeInjected),
  }));
}

function groupMatches(rows: MatchRow[]): SimilarRow[] {
  const bySession = new Map<string, SimilarRow>();
  for (const row of rows) {
    const existing = bySession.get(row.session_id);
    if (existing) {
      existing.score = Math.min(existing.score, row.score);
      existing.matched_turns += 1;
      if (existing.snippets.length < 3) {
        existing.snippets.push({
          turn: row.turn,
          role: row.role,
          snippet: row.snippet,
        });
      }
      continue;
    }
    bySession.set(row.session_id, {
      session_id: row.session_id,
      source: row.source,
      project_path: row.project_path,
      git_branch: row.git_branch,
      title: row.title,
      started_at: row.started_at,
      turn_count: row.turn_count,
      tool_call_count: row.tool_call_count,
      score: row.score,
      fts_score: row.score,
      matched_turns: 1,
      snippets: [{ turn: row.turn, role: row.role, snippet: row.snippet }],
      snippet: row.snippet,
      reconstruct_command: `agentmine session ${row.session_id} --md`,
    });
  }
  return [...bySession.values()].sort((a, b) => a.score - b.score);
}

async function findEmbeddingRows(
  db: DatabaseType,
  opts: {
    query: string;
    providerName: string;
    model: string;
    source?: string;
    project?: string;
    excludeSessions?: string[];
    filters: SimilarFilters;
  },
): Promise<SimilarRow[]> {
  const provider = createEmbeddingProvider(opts.providerName, opts.model);
  const modelInfo = provider.modelInfo(opts.model);
  const modelRow = db
    .prepare(
      `SELECT id FROM embedding_models
        WHERE provider = ? AND model = ? AND dimensions = ?`,
    )
    .get(modelInfo.provider, modelInfo.model, modelInfo.dimensions) as
    | { id: number }
    | undefined;
  if (!modelRow) {
    throw Errors.invalidInput(
      `No embedding index found for ${modelInfo.provider}/${modelInfo.model}/${modelInfo.dimensions}. Run \`agentmine embed --provider ${modelInfo.provider} --model ${modelInfo.model}\` first.`,
    );
  }

  const queryEmbedding = await provider.embedQuery(opts.query);
  const clauses = ["e.model_id = ?"];
  const params: unknown[] = [modelRow.id];
  if (opts.source) {
    clauses.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project) {
    clauses.push(projectPathClause("s.project_path"));
    params.push(...projectPathParams(opts.project));
  }
  addSessionFilterClauses(clauses, params, "s", opts.filters);
  if (!opts.filters.includeInjected) {
    addInjectedChunkExclusion(clauses, params, "c");
  }
  addExcludedSessionClause(
    clauses,
    params,
    "c.session_id",
    opts.excludeSessions,
  );

  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.session_id, c.start_turn, c.end_turn,
              c.retrieval_text, c.text_preview, c.source_kind,
              e.vector, e.vector_norm,
              s.source, s.project_path, s.git_branch, s.title,
              s.started_at, s.turn_count, s.tool_call_count
         FROM embeddings e
         JOIN embedding_chunks c ON c.id = e.chunk_id
         JOIN sessions s ON s.id = c.session_id
        WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as EmbeddingCandidateRow[];

  const toolQuery = isToolQuery(opts.query);
  const bySession = new Map<string, SimilarRow>();
  for (const row of rows) {
    const title = visibleTitle(row.title, opts.filters.includeInjected);
    let score = cosine(
      queryEmbedding.vector,
      deserializeVector(row.vector),
      row.vector_norm,
    );
    if (row.source_kind === "tool_summary" && !toolQuery) {
      score *= 0.65;
    }
    const snippet = row.text_preview ?? row.retrieval_text.slice(0, 240);
    score *= contentQualityMultiplier(title, snippet);
    const candidate = {
      session_id: row.session_id,
      source: row.source,
      project_path: row.project_path,
      git_branch: row.git_branch,
      title,
      started_at: row.started_at,
      turn_count: row.turn_count,
      tool_call_count: row.tool_call_count,
      score,
      embedding_score: score,
      matched_turns: 1,
      chunk_id: row.chunk_id,
      start_turn: row.start_turn,
      end_turn: row.end_turn,
      snippets: [{ turn: row.start_turn, role: "chunk", snippet }],
      snippet,
      reconstruct_command: `agentmine session ${row.session_id} --md`,
    } satisfies SimilarRow;
    const existing = bySession.get(row.session_id);
    if (
      !existing ||
      shouldReplaceEmbeddingCandidate(opts.query, existing, candidate)
    ) {
      bySession.set(row.session_id, candidate);
    } else if (existing.snippets.length < 3) {
      existing.snippets.push({ turn: row.start_turn, role: "chunk", snippet });
    }
  }

  return [...bySession.values()].sort(
    (a, b) => (b.embedding_score ?? 0) - (a.embedding_score ?? 0),
  );
}

export function mergeHybridRows(
  ftsRows: SimilarRow[],
  embeddingRows: SimilarRow[],
): SimilarRow[] {
  const bySession = new Map<string, SimilarRow>();
  const ftsRanks = new Map<string, number>();
  ftsRows.forEach((row, idx) => {
    ftsRanks.set(row.session_id, idx);
    bySession.set(
      row.session_id,
      applyResultQualityPenalty({
        ...row,
        score: hybridScore({ ftsRank: idx }),
      }),
    );
  });
  embeddingRows.forEach((row, idx) => {
    const existing = bySession.get(row.session_id);
    if (existing) {
      bySession.set(
        row.session_id,
        applyResultQualityPenalty({
          ...existing,
          chunk_id: row.chunk_id,
          start_turn: row.start_turn,
          end_turn: row.end_turn,
          embedding_score: row.embedding_score,
          score: hybridScore({
            ftsRank: ftsRanks.get(row.session_id),
            embeddingRank: idx,
            embeddingScore: row.embedding_score,
          }),
          snippets:
            existing.snippets.length > 0 ? existing.snippets : row.snippets,
          snippet: existing.snippet ?? row.snippet,
        }),
      );
      return;
    }
    bySession.set(
      row.session_id,
      applyResultQualityPenalty({
        ...row,
        score: hybridScore({
          embeddingRank: idx,
          embeddingScore: row.embedding_score,
        }),
      }),
    );
  });
  return [...bySession.values()].sort((a, b) => b.score - a.score);
}

function finalizeRows(
  query: string,
  rows: SimilarRow[],
  limit: number,
): { rows: SimilarRow[]; lowConfidence: boolean; warnings: string[] } {
  const limitedRows = rows.slice(0, limit);
  const lowConfidence = isLowConfidence(query, limitedRows);
  if (!lowConfidence) {
    return { rows: limitedRows, lowConfidence: false, warnings: [] };
  }
  return {
    rows: [],
    lowConfidence: true,
    warnings: ["low_confidence_matches"],
  };
}

function isLowConfidence(query: string, rows: SimilarRow[]): boolean {
  const terms = queryTerms(query);
  if (terms.length < 4 || rows.length === 0) return false;
  const topCoverage = Math.max(
    ...rows.slice(0, 3).map((row) => rowTermCoverage(terms, row)),
  );
  return topCoverage < 2;
}

function rowTermCoverage(terms: string[], row: SimilarRow): number {
  return termCoverage(
    terms,
    [
      row.title ?? "",
      row.snippet ?? "",
      ...row.snippets.map((snippet) => snippet.snippet),
    ].join(" "),
  );
}

function termCoverage(terms: string[], text: string): number {
  const normalized = text.toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase())).length;
}

function shouldReplaceEmbeddingCandidate(
  query: string,
  existing: SimilarRow,
  candidate: SimilarRow,
): boolean {
  const existingScore = existing.embedding_score ?? 0;
  const candidateScore = candidate.embedding_score ?? 0;
  if (candidateScore > existingScore + 0.02) return true;
  if (candidateScore < existingScore - 0.02) return false;

  const terms = queryTerms(query);
  return rowTermCoverage(terms, candidate) > rowTermCoverage(terms, existing);
}

function applyResultQualityPenalty(row: SimilarRow): SimilarRow {
  const multiplier = contentQualityMultiplier(
    row.title,
    [row.snippet ?? "", ...row.snippets.map((snippet) => snippet.snippet)].join(
      " ",
    ),
  );
  if (multiplier === 1) return row;
  return { ...row, score: row.score * multiplier };
}

function contentQualityMultiplier(
  title: string | null,
  snippet: string,
): number {
  const text = `${title ?? ""}\n${snippet}`.toLowerCase();
  if (
    text.includes("continuation prompt") ||
    text.includes("copy everything between") ||
    text.includes("you are resuming work on") ||
    text.includes("running one replay") ||
    text.startsWith("new session -")
  ) {
    return 0.35;
  }
  return 1;
}

function selectMode(
  db: DatabaseType,
  opts: {
    requestedMode: RequestedMode;
    providerName: string;
    model: string;
    source?: string;
    project?: string;
    excludedSessions: string[];
    filters: SimilarFilters;
  },
): ModeSelection {
  const guardrails: ModeSelection["guardrails"] = {
    current_session_excluded: opts.excludedSessions.length > 0,
    project_scoped: Boolean(opts.project),
  };
  if (opts.requestedMode !== "auto") {
    return {
      requested: opts.requestedMode,
      selected: opts.requestedMode,
      guardrails,
    };
  }

  const fallbackReasons: AutoFallbackReason[] = [];
  if (!guardrails.current_session_excluded) {
    fallbackReasons.push("missing_current_session_exclusion");
  }
  if (!guardrails.project_scoped) {
    fallbackReasons.push("missing_project_scope");
  }
  if (fallbackReasons.length > 0) {
    return {
      requested: "auto",
      selected: "fts",
      guardrails,
      fallback_reason: fallbackReasons[0],
      fallback_reasons: fallbackReasons,
    };
  }

  try {
    guardrails.embedding_index_found = hasUsableEmbeddingIndex(db, opts);
    guardrails.provider_available = true;
  } catch {
    guardrails.provider_available = false;
    return {
      requested: "auto",
      selected: "fts",
      guardrails,
      fallback_reason: "provider_unavailable",
      fallback_reasons: ["provider_unavailable"],
    };
  }

  if (!guardrails.embedding_index_found) {
    return {
      requested: "auto",
      selected: "fts",
      guardrails,
      fallback_reason: "missing_embedding_index",
      fallback_reasons: ["missing_embedding_index"],
    };
  }

  return { requested: "auto", selected: "hybrid", guardrails };
}

function fallBackToFts(
  selection: ModeSelection,
  reason: AutoFallbackReason,
): ModeSelection {
  return {
    ...selection,
    selected: "fts",
    guardrails: {
      ...selection.guardrails,
      provider_available:
        reason === "provider_unavailable"
          ? false
          : selection.guardrails.provider_available,
    },
    fallback_reason: reason,
    fallback_reasons: [reason],
  };
}

function hasUsableEmbeddingIndex(
  db: DatabaseType,
  opts: {
    providerName: string;
    model: string;
    source?: string;
    project?: string;
    excludedSessions: string[];
    filters: SimilarFilters;
  },
): boolean {
  const provider = createEmbeddingProvider(opts.providerName, opts.model);
  const modelInfo = provider.modelInfo(opts.model);
  const clauses: string[] = [];
  const params: unknown[] = [
    modelInfo.provider,
    modelInfo.model,
    modelInfo.dimensions,
  ];
  if (opts.source) {
    clauses.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project) {
    clauses.push(projectPathClause("s.project_path"));
    params.push(...projectPathParams(opts.project));
  }
  addSessionFilterClauses(clauses, params, "s", opts.filters);
  if (!opts.filters.includeInjected) {
    addInjectedChunkExclusion(clauses, params, "c");
  }
  addExcludedSessionClause(
    clauses,
    params,
    "c.session_id",
    opts.excludedSessions,
  );
  const modelRow = db
    .prepare(
      `SELECT 1
         FROM embedding_models m
         JOIN embeddings e ON e.model_id = m.id
         JOIN embedding_chunks c ON c.id = e.chunk_id
         JOIN sessions s ON s.id = c.session_id
        WHERE m.provider = ?
          AND m.model = ?
          AND m.dimensions = ?
          ${clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : ""}
        LIMIT 1`,
    )
    .get(...params) as { usable: number } | undefined;
  return Boolean(modelRow);
}

function semanticExclusionWarnings(
  mode: RetrievalMode,
  excludedSessions: string[],
): string[] {
  return mode === "fts" || excludedSessions.length > 0
    ? []
    : ["missing_current_session_exclusion"];
}

function semanticExclusionFields(
  mode: RetrievalMode,
  excludedSessions: string[],
): { exclusion_warning?: "missing_current_session" } {
  return mode === "fts" || excludedSessions.length > 0
    ? {}
    : { exclusion_warning: "missing_current_session" };
}

function warningFields(warnings: string[]): { warnings?: string[] } {
  return warnings.length > 0 ? { warnings } : {};
}

function confidenceFields(lowConfidence: boolean): { low_confidence?: true } {
  return lowConfidence ? { low_confidence: true } : {};
}

function searchFilterFields(filters: SimilarFilters): {
  since_filter: SimilarFilters["since"] | null;
  until_filter: SimilarFilters["until"] | null;
  root_only: boolean;
  injected_messages_excluded: boolean;
} {
  return {
    since_filter: filters.since ?? null,
    until_filter: filters.until ?? null,
    root_only: filters.rootOnly,
    injected_messages_excluded: !filters.includeInjected,
  };
}

function visibleTitle(
  title: string | null,
  includeInjected: boolean,
): string | null {
  return !includeInjected && isInjectedNoise(title) ? null : title;
}

function hybridScore(ranks: {
  ftsRank?: number;
  embeddingRank?: number;
  embeddingScore?: number;
}): number {
  const ftsComponent =
    ranks.ftsRank === undefined || ranks.ftsRank < 0
      ? 0
      : 0.6 / (ranks.ftsRank + 1);
  const embeddingStrength = Math.max(0, ranks.embeddingScore ?? 1);
  const embeddingComponent =
    ranks.embeddingRank === undefined || ranks.embeddingRank < 0
      ? 0
      : (0.4 * embeddingStrength) / (ranks.embeddingRank + 1);
  return ftsComponent + embeddingComponent;
}

function cosine(
  query: Float32Array,
  candidate: Float32Array,
  candidateNorm: number,
): number {
  let dot = 0;
  let queryNormSq = 0;
  const n = Math.min(query.length, candidate.length);
  for (let i = 0; i < n; i += 1) {
    dot += query[i]! * candidate[i]!;
    queryNormSq += query[i]! * query[i]!;
  }
  const denom = Math.sqrt(queryNormSq) * candidateNorm;
  return denom > 0 ? dot / denom : 0;
}

function isToolQuery(query: string): boolean {
  return /\b(?:tool|command|shell|bash|zsh|stderr|stdout|exit|npm|pnpm|git|test|build|lint|error|stack|trace|cli)\b/i.test(
    query,
  );
}

function toFtsQuery(input: string): string {
  const terms = queryTerms(input);
  if (!terms || terms.length === 0) return "";
  return [...new Set(terms)].map((term) => `"${term}"`).join(" OR ");
}

function queryTerms(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.map((term) => term.replace(/"/g, ""))
        .filter((term) => term.length >= 2) ?? [],
    ),
  ];
}

function parseLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback;
  return n;
}

function parseMode(v: unknown): RequestedMode {
  const mode = String(v ?? "auto");
  if (
    mode === "auto" ||
    mode === "fts" ||
    mode === "embedding" ||
    mode === "hybrid"
  )
    return mode;
  throw Errors.invalidInput(
    `--mode must be one of auto|fts|embedding|hybrid (got '${mode}')`,
  );
}

function parseSimilarFilters(args: Record<string, unknown>): SimilarFilters {
  const since = parseTimeFilter(args.since, "--since", parseSince);
  const until = parseTimeFilter(args.until, "--until", parseUntil);
  if (
    since !== undefined &&
    until !== undefined &&
    since.epoch >= until.epoch
  ) {
    throw Errors.invalidInput(
      `--since must resolve before --until (got '${since.input}' and '${until.input}')`,
    );
  }
  return {
    since,
    until,
    rootOnly: Boolean(args["root-only"]),
    includeInjected: Boolean(args["include-injected"]),
  };
}

function parseTimeFilter(
  value: unknown,
  flag: "--since" | "--until",
  parse: (input: string) => number | null,
): { input: string; epoch: number } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const input = String(value);
  const epoch = parse(input);
  if (epoch === null) {
    throw Errors.invalidInput(
      `${flag} must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${input}')`,
    );
  }
  return { input, epoch };
}

function inferCurrentProjectFilter(
  db: DatabaseType,
  cwd: string,
): string | undefined {
  const cwdPath = normalizePath(cwd);
  const cwdComparable = normalizeComparablePath(cwd);
  const rows = db
    .prepare(
      `SELECT DISTINCT project_path
         FROM sessions
        WHERE project_path IS NOT NULL
          AND project_path != ''`,
    )
    .all() as Array<{ project_path: string }>;
  const projectPaths = rows
    .map((row) => ({
      path: normalizePath(row.project_path),
      comparable: normalizeComparablePath(row.project_path),
    }))
    .filter((row) => row.path && row.comparable);
  const exact = projectPaths.find(
    (projectPath) => projectPath.comparable === cwdComparable,
  );
  if (exact) {
    return exact.path;
  }
  if (
    projectPaths.some((projectPath) =>
      isSameOrInside(projectPath.comparable, cwdComparable),
    )
  ) {
    return cwdPath;
  }
  return projectPaths
    .filter((projectPath) =>
      isSameOrInside(cwdComparable, projectPath.comparable),
    )
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
}

function parseSessionList(value: unknown): string[] {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveExcludedSessions(db: DatabaseType, seeds: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...new Set(seeds)];
  while (queue.length > 0) {
    const sessionId = queue.shift();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);

    const parent = db
      .prepare(`SELECT parent_session_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { parent_session_id: string | null } | undefined;
    if (parent?.parent_session_id && !seen.has(parent.parent_session_id)) {
      queue.push(parent.parent_session_id);
    }

    const children = db
      .prepare(
        `SELECT id FROM sessions WHERE parent_session_id = ?
         UNION
         SELECT child_session_id AS id
           FROM subagent_invocations
          WHERE parent_session_id = ?
            AND child_session_id IS NOT NULL`,
      )
      .all(sessionId, sessionId) as Array<{ id: string }>;
    for (const child of children) {
      if (child.id && !seen.has(child.id)) queue.push(child.id);
    }
  }
  return [...seen].sort();
}

function addExcludedSessionClause(
  clauses: string[],
  params: unknown[],
  column: string,
  excludeSessions: string[] | undefined,
): void {
  if (!excludeSessions || excludeSessions.length === 0) return;
  clauses.push(
    `${column} NOT IN (${excludeSessions.map(() => "?").join(", ")})`,
  );
  params.push(...excludeSessions);
}

function addSessionFilterClauses(
  clauses: string[],
  params: unknown[],
  sessionAlias: string,
  filters: SimilarFilters,
): void {
  if (filters.since) {
    clauses.push(`${sessionAlias}.started_at >= ?`);
    params.push(filters.since.epoch);
  }
  if (filters.until) {
    clauses.push(`${sessionAlias}.started_at < ?`);
    params.push(filters.until.epoch);
  }
  if (filters.rootOnly) {
    clauses.push(`${sessionAlias}.parent_session_id IS NULL`);
  }
}

function addInjectedTextExclusion(
  clauses: string[],
  params: unknown[],
  column: string,
): void {
  addPrefixExclusion(clauses, params, column, INJECTED_TEXT_PREFIXES);
}

function addInjectedChunkExclusion(
  clauses: string[],
  params: unknown[],
  chunkAlias: string,
): void {
  clauses.push(
    `NOT EXISTS (
       SELECT 1
         FROM messages injected_message
        WHERE injected_message.session_id = ${chunkAlias}.session_id
          AND injected_message.turn BETWEEN ${chunkAlias}.start_turn AND ${chunkAlias}.end_turn
          AND (${prefixMatchSql("injected_message.text", INJECTED_TEXT_PREFIXES)})
     )`,
  );
  params.push(...INJECTED_TEXT_PREFIXES.map((prefix) => `${prefix}%`));
}

function addPrefixExclusion(
  clauses: string[],
  params: unknown[],
  column: string,
  prefixes: readonly string[],
): void {
  clauses.push(`NOT (${prefixMatchSql(column, prefixes)})`);
  params.push(...prefixes.map((prefix) => `${prefix}%`));
}

function prefixMatchSql(column: string, prefixes: readonly string[]): string {
  return prefixes.map(() => `LTRIM(${column}) LIKE ?`).join(" OR ");
}

function projectPathClause(column: string): string {
  return `(${column} = ? OR ${column} LIKE ?)`;
}

function projectPathParams(project: string): [string, string] {
  const normalized = normalizePath(project);
  return [normalized, `${normalized}${sep}%`];
}

function normalizePath(path: string): string {
  return resolve(path).replace(new RegExp(`${escapeRegExp(sep)}+$`), "");
}

function normalizeComparablePath(path: string): string {
  try {
    return normalizePath(realpathSync.native(path));
  } catch {
    return normalizePath(path);
  }
}

function isSameOrInside(path: string, possibleParent: string): boolean {
  return path === possibleParent || path.startsWith(`${possibleParent}${sep}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
