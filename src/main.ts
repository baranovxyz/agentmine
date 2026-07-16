import { defineCommand, runMain } from "citty";
import { backupCommand } from "./commands/backup.js";
import { embedCommand } from "./commands/embed.js";
import { extractCommand } from "./commands/extract.js";
import { ftsCommand } from "./commands/fts.js";
import { ingestCommand } from "./commands/ingest.js";
import { normalizeCommand } from "./commands/normalize.js";
import { pricesCommand } from "./commands/prices.js";
import { purgeCommand } from "./commands/purge.js";
import { queryCommand } from "./commands/query.js";
import { schemaCommand } from "./commands/schema.js";
import { sessionCommand } from "./commands/session.js";
import { sessionsCommand } from "./commands/sessions.js";
import { similarCommand } from "./commands/similar.js";
import { statsCommand } from "./commands/stats.js";
import { syncCommand } from "./commands/sync.js";
import { timelineCommand } from "./commands/timeline.js";
import { topCommand } from "./commands/top.js";
import { workflowCommand } from "./commands/workflow.js";
import { workflowsCommand } from "./commands/workflows.js";
import { VERSION } from "./version.js";

const main = defineCommand({
  meta: {
    name: "agentmine",
    version: VERSION,
    description:
      "Queryable work corpus of coding-agent sessions. Mine prior work, skills, and workflow patterns with plain SQL.",
  },
  subCommands: {
    schema: schemaCommand,
    backup: backupCommand,
    sync: syncCommand,
    ingest: ingestCommand,
    normalize: normalizeCommand,
    extract: extractCommand,
    embed: embedCommand,
    stats: statsCommand,
    top: topCommand,
    query: queryCommand,
    fts: ftsCommand,
    session: sessionCommand,
    sessions: sessionsCommand,
    similar: similarCommand,
    timeline: timelineCommand,
    prices: pricesCommand,
    purge: purgeCommand,
    workflows: workflowsCommand,
    workflow: workflowCommand,
  },
});

runMain(main);
