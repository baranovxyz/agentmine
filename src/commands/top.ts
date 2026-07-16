import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";
import { aggregateNgrams } from "../extract/ngrams.js";
import { parseSince, parseUntil } from "./_filters.js";

type DateRange = { since: number | null; until: number | null };

function rangeMeta(range: DateRange): Record<string, number> {
  const out: Record<string, number> = {};
  if (range.since !== null) out.since_epoch = range.since;
  if (range.until !== null) out.until_epoch = range.until;
  return out;
}

function resolveDateRange(args: Record<string, unknown>): DateRange {
  const out: DateRange = { since: null, until: null };
  if (args.since !== undefined && args.since !== null && args.since !== "") {
    const ts = parseSince(String(args.since));
    if (ts === null) {
      throw Errors.invalidInput(
        `--since must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${String(args.since)}')`,
      );
    }
    out.since = ts;
  }
  if (args.until !== undefined && args.until !== null && args.until !== "") {
    const ts = parseUntil(String(args.until));
    if (ts === null) {
      throw Errors.invalidInput(
        `--until must be ISO date, YYYY-MM-DD, or relative offset like 7d/2w/12h (got '${String(args.until)}')`,
      );
    }
    out.until = ts;
  }
  return out;
}

type Data = Record<string, unknown>;
type Outcome = CommandOutcome<Data>;

const topFiles = defineCommand({
  meta: { name: "files", description: "Most-touched files from files_touched" },
  args: {
    op: {
      type: "string",
      description: "Filter by op (read|edit|write|delete)",
    },
    limit: { type: "string", default: "20", description: "Max rows" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top files",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          let rows: unknown[];
          if (args.op) {
            rows = db
              .prepare(
                `SELECT path, COUNT(*) AS ops, COUNT(DISTINCT session_id) AS sessions
                   FROM files_touched WHERE op = ?
                   GROUP BY path ORDER BY ops DESC LIMIT ?`,
              )
              .all(String(args.op), limit);
          } else {
            rows = db
              .prepare(
                `SELECT path, ops, reads, writes, sessions FROM v_top_files
                  ORDER BY ops DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topCommands = defineCommand({
  meta: { name: "commands", description: "Most-run shell commands" },
  args: {
    failed: {
      type: "boolean",
      default: false,
      description: "Only failing (exit_code != 0)",
    },
    head: { type: "string", description: "Filter by cmd_head prefix" },
    limit: { type: "string", default: "20" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top commands",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          let rows: unknown[];
          let filter: string | undefined;
          if (args.failed) {
            const where = args.head
              ? `cmd_head LIKE ? AND exit_code != 0`
              : `exit_code != 0`;
            const params: unknown[] = args.head
              ? [`${args.head}%`, limit]
              : [limit];
            rows = db
              .prepare(
                `SELECT cmd_head, cmd_full, COUNT(*) AS failures, session_id, turn
                   FROM shell_commands WHERE ${where}
                   GROUP BY cmd_full ORDER BY failures DESC LIMIT ?`,
              )
              .all(...params);
            filter = "failed";
          } else if (args.head) {
            rows = db
              .prepare(
                `SELECT cmd_head, runs, failures, sessions FROM v_top_shell_heads
                   WHERE cmd_head LIKE ? ORDER BY runs DESC LIMIT ?`,
              )
              .all(`${args.head}%`, limit);
          } else {
            rows = db
              .prepare(
                `SELECT cmd_head, runs, failures, sessions FROM v_top_shell_heads
                  ORDER BY runs DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit, ...(filter ? { filter } : {}) } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topCorrections = defineCommand({
  meta: { name: "corrections", description: "Aggregate user corrections" },
  args: {
    by: { type: "string", default: "kind", description: "kind|project|source" },
    limit: { type: "string", default: "20" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top corrections",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          const by = String(args.by);
          if (!["kind", "project", "source"].includes(by)) {
            throw Errors.invalidInput(
              `--by must be one of kind|project|source (got '${by}')`,
            );
          }
          let rows: unknown[];
          if (by === "kind") {
            rows = db.prepare(`SELECT * FROM v_corrections_by_kind`).all();
          } else if (by === "project") {
            rows = db
              .prepare(
                `SELECT project_path, kind, COUNT(*) AS n,
                        SUM(COALESCE(followed_by_revert, 0)) AS reverts
                   FROM user_corrections
                   WHERE project_path IS NOT NULL
                   GROUP BY project_path, kind
                   HAVING n >= 1
                   ORDER BY n DESC LIMIT ?`,
              )
              .all(limit);
          } else {
            rows = db
              .prepare(
                `SELECT source, kind, COUNT(*) AS n FROM user_corrections
                 GROUP BY source, kind ORDER BY source, n DESC`,
              )
              .all();
          }
          return { data: { by, rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topSkills = defineCommand({
  meta: { name: "skills", description: "Most-invoked skills" },
  args: {
    limit: { type: "string", default: "20" },
    since: {
      type: "string",
      description:
        "Only sessions on/after; ISO date, YYYY-MM-DD, or relative offset (e.g. 7d, 2w)",
    },
    until: {
      type: "string",
      description:
        "Only sessions before (YYYY-MM-DD treated as exclusive end-of-day); ISO date or relative offset",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top skills",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const range = resolveDateRange(args);
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          const hasRange = range.since !== null || range.until !== null;
          let rows: unknown[];
          if (hasRange) {
            const clauses: string[] = [];
            const params: unknown[] = [];
            if (range.since !== null) {
              clauses.push("sess.started_at >= ?");
              params.push(range.since);
            }
            if (range.until !== null) {
              clauses.push("sess.started_at < ?");
              params.push(range.until);
            }
            params.push(limit);
            rows = db
              .prepare(
                `SELECT si.skill_name,
                        COUNT(*) AS invocations,
                        COUNT(DISTINCT si.session_id) AS sessions
                   FROM skills_invoked si
                   JOIN sessions sess ON sess.id = si.session_id
                  WHERE ${clauses.join(" AND ")}
                  GROUP BY si.skill_name
                  ORDER BY invocations DESC
                  LIMIT ?`,
              )
              .all(...params);
          } else {
            rows = db
              .prepare(
                `SELECT skill_name, invocations, sessions FROM v_top_skills
                  ORDER BY invocations DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit, ...rangeMeta(range) } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topMcp = defineCommand({
  meta: { name: "mcp", description: "Most-called MCP server/tool pairs" },
  args: {
    server: { type: "string", description: "Filter by server (prefix match)" },
    limit: { type: "string", default: "30" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top mcp",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 30);
          let rows: unknown[];
          if (args.server) {
            rows = db
              .prepare(
                `SELECT server, tool, calls, sessions FROM v_top_mcp
                  WHERE server LIKE ? ORDER BY calls DESC LIMIT ?`,
              )
              .all(`${args.server}%`, limit);
          } else {
            rows = db
              .prepare(
                `SELECT server, tool, calls, sessions FROM v_top_mcp
                  ORDER BY calls DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topWeb = defineCommand({
  meta: { name: "web", description: "Most-fetched web domains" },
  args: {
    domain: { type: "string", description: "Filter by domain (prefix match)" },
    limit: { type: "string", default: "20" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top web",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          let rows: unknown[];
          if (args.domain) {
            rows = db
              .prepare(
                `SELECT domain, kind, hits, sessions FROM v_top_web
                  WHERE domain LIKE ? ORDER BY hits DESC LIMIT ?`,
              )
              .all(`${args.domain}%`, limit);
          } else {
            rows = db
              .prepare(
                `SELECT domain, kind, hits, sessions FROM v_top_web
                  ORDER BY hits DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topSequences = defineCommand({
  meta: { name: "sequences", description: "Recurring tool-call n-grams" },
  args: {
    n: { type: "string", default: "3", description: "Sequence length (2|3|4)" },
    limit: { type: "string", default: "30" },
    project: {
      type: "string",
      description:
        "Filter to sessions whose project_path matches this SQL LIKE pattern (e.g. /home/me/repo or /home/me/repo/%). Re-aggregates ngrams on-demand from filtered tool_calls.",
    },
    "min-count": {
      type: "string",
      description:
        "Minimum count threshold for re-aggregated sequences (only used with --project; defaults to 3)",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top sequences",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const n = toLimit(args.n, 3);
          if (n < 2 || n > 4)
            throw Errors.invalidInput(`--n must be 2, 3, or 4 (got ${n})`);
          const limit = toLimit(args.limit, 30);
          const project =
            args.project !== undefined &&
            args.project !== null &&
            args.project !== ""
              ? String(args.project)
              : null;

          if (project === null) {
            const rows = db
              .prepare(
                `SELECT sequence, count, sessions, example_session_id, example_start_turn
                   FROM tool_call_ngrams WHERE n = ?
                  ORDER BY count DESC LIMIT ?`,
              )
              .all(n, limit);
            return { data: { rows, n, limit } };
          }

          const minCount = toLimit(args["min-count"], 3);
          const calls = db
            .prepare<
              [string],
              { session_id: string; turn: number; idx: number; name: string }
            >(
              `SELECT tc.session_id, tc.turn, tc.idx, tc.name
                 FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
                WHERE s.project_path LIKE ?
                ORDER BY tc.session_id, tc.turn, tc.idx`,
            )
            .all(project);
          const aggs = aggregateNgrams(calls, { nValues: [n], minCount });
          aggs.sort((a, b) => b.count - a.count);
          const rows = aggs.slice(0, limit).map((a) => ({
            sequence: a.sequence,
            count: a.count,
            sessions: a.sessions,
            example_session_id: a.example_session_id,
            example_start_turn: a.example_start_turn,
          }));
          return {
            data: {
              rows,
              n,
              limit,
              project,
              min_count: minCount,
              sessions_scanned: new Set(calls.map((c) => c.session_id)).size,
            },
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topPrompts = defineCommand({
  meta: {
    name: "prompts",
    description: "Recurring prompt templates (first-user-prompt shapes)",
  },
  args: { limit: { type: "string", default: "20" } },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top prompts",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          const rows = db
            .prepare(
              `SELECT template, count, example_session_ids FROM prompt_templates
                ORDER BY count DESC LIMIT ?`,
            )
            .all(limit);
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topErrors = defineCommand({
  meta: { name: "errors", description: "Aggregate tool errors by category" },
  args: {
    tool: { type: "string", description: "Filter by tool_name" },
    limit: { type: "string", default: "20" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top errors",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          let rows: unknown[];
          if (args.tool) {
            rows = db
              .prepare(
                `SELECT error_category, COUNT(*) AS n, COUNT(DISTINCT session_id) AS sessions
                   FROM tool_errors WHERE tool_name = ?
                  GROUP BY error_category ORDER BY n DESC LIMIT ?`,
              )
              .all(String(args.tool), limit);
          } else {
            rows = db
              .prepare(
                `SELECT tool_name, error_category, COUNT(*) AS n
                   FROM tool_errors GROUP BY tool_name, error_category
                   ORDER BY n DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topSubagents = defineCommand({
  meta: { name: "subagents", description: "Subagent-type usage" },
  args: {
    limit: { type: "string", default: "20" },
    since: {
      type: "string",
      description:
        "Only parent sessions on/after; ISO date, YYYY-MM-DD, or relative offset (e.g. 7d, 2w)",
    },
    until: {
      type: "string",
      description:
        "Only parent sessions before (YYYY-MM-DD treated as exclusive end-of-day); ISO date or relative offset",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top subagents",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const range = resolveDateRange(args);
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          const hasRange = range.since !== null || range.until !== null;
          let rows: unknown[];
          if (hasRange) {
            const clauses: string[] = [];
            const params: unknown[] = [];
            if (range.since !== null) {
              clauses.push("sess.started_at >= ?");
              params.push(range.since);
            }
            if (range.until !== null) {
              clauses.push("sess.started_at < ?");
              params.push(range.until);
            }
            params.push(limit);
            rows = db
              .prepare(
                `SELECT sa.subagent_type,
                        COUNT(*) AS invocations,
                        COUNT(DISTINCT sa.parent_session_id) AS parent_sessions
                   FROM subagent_invocations sa
                   JOIN sessions sess ON sess.id = sa.parent_session_id
                  WHERE ${clauses.join(" AND ")}
                    AND sa.subagent_type IS NOT NULL
                  GROUP BY sa.subagent_type
                  ORDER BY invocations DESC
                  LIMIT ?`,
              )
              .all(...params);
          } else {
            rows = db
              .prepare(
                `SELECT subagent_type, invocations, parent_sessions FROM v_top_subagents
                  ORDER BY invocations DESC LIMIT ?`,
              )
              .all(limit);
          }
          return { data: { rows, limit, ...rangeMeta(range) } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const topSelfResolutions = defineCommand({
  meta: {
    name: "self-resolutions",
    description:
      "Agent breakthroughs: same args_hash failed then succeeded, no user turn between",
  },
  args: {
    "min-gap": {
      type: "string",
      default: "1",
      description: "Minimum gap_turns",
    },
    tool: { type: "string", description: "Filter by tool_name" },
    "show-context": {
      type: "boolean",
      default: false,
      description: "Include intermediate tool calls + assistant reasoning",
    },
    limit: { type: "string", default: "20" },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top self-resolutions",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const limit = toLimit(args.limit, 20);
          const minGap = toLimit(args["min-gap"], 1);
          const showContext = Boolean(args["show-context"]);
          const params: unknown[] = [minGap];
          let where = `sr.gap_turns >= ?`;
          if (args.tool) {
            where += ` AND sr.tool_name = ?`;
            params.push(String(args.tool));
          }
          params.push(limit);

          const baseCols = showContext
            ? `sr.session_id, sr.fail_turn, sr.ok_turn, sr.gap_turns, sr.tool_name,
               substr(sr.args_preview, 1, 160) AS args_preview,
               sr.resolution_tool_calls_json, sr.resolution_reasoning_json,
               s.project_path`
            : `sr.session_id, sr.fail_turn, sr.ok_turn, sr.gap_turns, sr.tool_name,
               substr(sr.args_preview, 1, 160) AS args_preview,
               s.project_path`;

          const rows = db
            .prepare(
              `SELECT ${baseCols}
                 FROM self_resolutions sr
                 JOIN sessions s ON s.id = sr.session_id
                WHERE ${where}
                ORDER BY sr.gap_turns DESC, sr.session_id LIMIT ?`,
            )
            .all(...params);
          return { data: { rows, limit, minGap, showContext } };
        } finally {
          db.close();
        }
      },
    });
  },
});

const TOKENS_BY = ["model", "project", "session", "day", "source"] as const;
type TokensBy = (typeof TOKENS_BY)[number];

const topTokens = defineCommand({
  meta: {
    name: "tokens",
    description:
      "Aggregate session token volume + USD cost by model/project/session/day/source. Cost uses the local model_prices table — run `agentmine prices sync` first (LiteLLM data, the same source ccusage uses). Unpriced models contribute 0 and are counted in unpriced_sessions.",
  },
  args: {
    by: {
      type: "string",
      default: "model",
      description: "model | project | session | day | source",
    },
    project: {
      type: "string",
      description:
        "Filter to sessions whose project_path matches this SQL LIKE pattern",
    },
    limit: { type: "string", default: "20" },
    since: {
      type: "string",
      description: "Restrict to sessions started on/after this date",
    },
    until: {
      type: "string",
      description: "Restrict to sessions started before this date",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine top tokens",
      handler: async (): Promise<Outcome> => {
        requireDb();
        const db = openDb({ readonly: true });
        try {
          const by = String(args.by) as TokensBy;
          if (!TOKENS_BY.includes(by)) {
            throw Errors.invalidInput(
              `--by must be one of ${TOKENS_BY.join("|")} (got '${by}')`,
            );
          }
          const limit = toLimit(args.limit, 20);
          const range = resolveDateRange(args as Record<string, unknown>);
          const project =
            args.project !== undefined &&
            args.project !== null &&
            args.project !== ""
              ? String(args.project)
              : null;

          const where: string[] = [
            `(input_tokens IS NOT NULL OR output_tokens IS NOT NULL)`,
          ];
          const params: unknown[] = [];
          if (range.since !== null) {
            where.push(`started_at >= ?`);
            params.push(range.since);
          }
          if (range.until !== null) {
            where.push(`started_at < ?`);
            params.push(range.until);
          }
          if (project !== null) {
            where.push(`project_path LIKE ?`);
            params.push(project);
          }

          // Per-session cost = tokens × per-1M price / 1e6, summed over the
          // group. Each session has one model; LEFT JOIN model_prices keeps
          // unpriced sessions (NULL price → 0 contribution, counted separately).
          // reasoning_tokens are excluded from cost (no separate price field).
          const costSum = `ROUND(SUM(
              COALESCE(s.input_tokens, 0) * COALESCE(p.input_per_mtok, 0)
            + COALESCE(s.output_tokens, 0) * COALESCE(p.output_per_mtok, 0)
            + COALESCE(s.cache_read_tokens, 0) * COALESCE(p.cache_read_per_mtok, 0)
            + COALESCE(s.cache_creation_tokens, 0) * COALESCE(p.cache_write_per_mtok, 0)
            ) / 1e6, 4) AS cost_usd`;
          const tokenSums = `
            COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
            COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
            COALESCE(SUM(s.cache_creation_tokens), 0) AS cache_creation_tokens,
            COALESCE(SUM(s.cache_read_tokens), 0) AS cache_read_tokens,
            COALESCE(SUM(s.reasoning_tokens), 0) AS reasoning_tokens,
            COUNT(*) AS sessions,
            ${costSum},
            SUM(CASE WHEN p.model IS NULL
                      AND (s.input_tokens IS NOT NULL OR s.output_tokens IS NOT NULL)
                     THEN 1 ELSE 0 END) AS unpriced_sessions
          `;
          // total = input + output + cache_creation + cache_read + reasoning
          const orderBy = `(${[
            "COALESCE(SUM(s.input_tokens), 0)",
            "COALESCE(SUM(s.output_tokens), 0)",
            "COALESCE(SUM(s.cache_creation_tokens), 0)",
            "COALESCE(SUM(s.cache_read_tokens), 0)",
            "COALESCE(SUM(s.reasoning_tokens), 0)",
          ].join(" + ")}) DESC`;
          const pricesLoaded =
            (
              db
                .prepare<[], { c: number }>(
                  `SELECT COUNT(*) AS c FROM model_prices`,
                )
                .get() ?? {
                c: 0,
              }
            ).c > 0;

          const join = `sessions s LEFT JOIN model_prices p ON p.model = s.model`;
          let sql: string;
          if (by === "session") {
            sql = `SELECT s.id AS session_id, s.model, s.project_path,
                          COALESCE(s.input_tokens, 0) AS input_tokens,
                          COALESCE(s.output_tokens, 0) AS output_tokens,
                          COALESCE(s.cache_creation_tokens, 0) AS cache_creation_tokens,
                          COALESCE(s.cache_read_tokens, 0) AS cache_read_tokens,
                          COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
                          ROUND((COALESCE(s.input_tokens,0)*COALESCE(p.input_per_mtok,0)
                                +COALESCE(s.output_tokens,0)*COALESCE(p.output_per_mtok,0)
                                +COALESCE(s.cache_read_tokens,0)*COALESCE(p.cache_read_per_mtok,0)
                                +COALESCE(s.cache_creation_tokens,0)*COALESCE(p.cache_write_per_mtok,0))/1e6, 4) AS cost_usd,
                          CASE WHEN p.model IS NULL THEN 1 ELSE 0 END AS unpriced,
                          s.started_at
                     FROM ${join}
                    WHERE ${where.join(" AND ")}
                    ORDER BY (COALESCE(s.input_tokens,0)+COALESCE(s.output_tokens,0)
                              +COALESCE(s.cache_creation_tokens,0)+COALESCE(s.cache_read_tokens,0)
                              +COALESCE(s.reasoning_tokens,0)) DESC
                    LIMIT ?`;
          } else if (by === "day") {
            sql = `SELECT date(s.started_at, 'unixepoch') AS day,
                          ${tokenSums}
                     FROM ${join}
                    WHERE ${where.join(" AND ")} AND s.started_at IS NOT NULL
                    GROUP BY day
                    ORDER BY ${orderBy}
                    LIMIT ?`;
          } else {
            const col =
              by === "model"
                ? "s.model"
                : by === "project"
                  ? "s.project_path"
                  : "s.source";
            const alias =
              by === "model"
                ? "model"
                : by === "project"
                  ? "project_path"
                  : "source";
            sql = `SELECT ${col} AS ${alias},
                          ${tokenSums}
                     FROM ${join}
                    WHERE ${where.join(" AND ")} AND ${col} IS NOT NULL
                    GROUP BY ${col}
                    ORDER BY ${orderBy}
                    LIMIT ?`;
          }

          const rows = db.prepare(sql).all(...params, limit);
          return {
            data: {
              by,
              rows,
              limit,
              prices_loaded: pricesLoaded,
              ...(project !== null ? { project } : {}),
              ...rangeMeta(range),
            },
            ...(pricesLoaded
              ? {}
              : {
                  warnings: [
                    {
                      name: "NO_PRICES_LOADED",
                      message:
                        "model_prices is empty — cost_usd is 0. Run `agentmine prices sync` first.",
                    },
                  ],
                }),
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

export const topCommand = defineCommand({
  meta: { name: "top", description: "Aggregate views over the corpus" },
  subCommands: {
    files: topFiles,
    commands: topCommands,
    corrections: topCorrections,
    skills: topSkills,
    mcp: topMcp,
    web: topWeb,
    sequences: topSequences,
    prompts: topPrompts,
    errors: topErrors,
    subagents: topSubagents,
    "self-resolutions": topSelfResolutions,
    tokens: topTokens,
  },
});

function requireDb(): void {
  if (!dbExists()) {
    throw Errors.notFound(
      "sessions.db not found. Run `agentmine normalize` + `agentmine extract` first.",
    );
  }
}

function toLimit(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return fallback;
  return n;
}
