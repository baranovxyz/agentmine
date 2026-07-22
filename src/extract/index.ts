import type { DatabaseType } from "../db/client.js";
import { extractCommitStatus } from "./commit.js";
import { extractUserCorrections } from "./corrections.js";
import { extractToolErrors } from "./errors.js";
import { extractFilesTouched } from "./files.js";
import { extractFrictionEvents } from "./friction.js";
import { extractGitOperations } from "./git.js";
import { extractUserInterruptions } from "./interrupts.js";
import { extractMcpCalls } from "./mcp.js";
import { extractToolCallNgrams } from "./ngrams.js";
import { type ExtractScope, runScoped } from "./scope.js";
import { extractSearchCalls } from "./search.js";
import { extractSelfResolutions } from "./selfResolutions.js";
import { extractShellCommands } from "./shell.js";
import { extractSkillsInvoked } from "./skills.js";
import { extractSkillsAvailable } from "./skillsAvailable.js";
import { extractSkillsHookInjected } from "./skillsHookInjected.js";
import { extractSubagentInvocations } from "./subagents.js";
import { extractPromptTemplates } from "./templates.js";
import { extractTodoEvents } from "./todos.js";
import { extractWebFetches } from "./web.js";
import { extractWorkflowRuns } from "./workflows.js";

export interface ExtractorResult {
  files_touched: number;
  shell_commands: number;
  tool_errors: number;
  user_corrections: number;
  skills_invoked: number;
  skills_available: number;
  skills_hook_injected: number;
  mcp_calls: number;
  web_fetches: number;
  git_operations: number;
  todo_events: number;
  user_interruptions: number;
  tool_call_ngrams: number;
  prompt_templates: number;
  friction_events: number;
  subagent_invocations: number;
  self_resolutions: number;
  commit_status: number;
  search_calls: number;
  workflow_runs: number;
  [key: string]: number;
}

/**
 * Run every extractor in order. Each extractor manages its own DELETE + INSERT
 * within its own transaction so re-runs are idempotent.
 *
 * `sessionIds` bounds the per-session extractors to a changed set (incremental
 * mode); `null` rebuilds the whole corpus. The corpus-aggregate extractors
 * (subagents, ngrams, templates, and the subagent-count rollup) always rebuild
 * fully — their output is a function of the entire corpus and they are cheap.
 *
 * Order is significant for two extractors:
 *   - corrections.ts reads `shell_commands` for `followed_by_revert`, so shell must run first.
 *   - git.ts reads `shell_commands` for the cmd_head='git' filter, so shell must run first.
 *   - friction.ts reads `shell_commands`, `files_touched`, and `tool_calls`; runs after them.
 *   - ngrams.ts and templates.ts only read `tool_calls` / `sessions`; order-independent.
 */
export function runAllExtractors(
  db: DatabaseType,
  sessionIds: readonly string[] | null = null,
): ExtractorResult {
  return runScoped(db, sessionIds, (scope) => runExtractors(db, scope));
}

function runExtractors(db: DatabaseType, scope: ExtractScope): ExtractorResult {
  const files_touched = extractFilesTouched(db, scope);
  const shell_commands = extractShellCommands(db, scope);
  const tool_errors = extractToolErrors(db, scope);
  const skills_invoked = extractSkillsInvoked(db, scope);
  const skills_available = extractSkillsAvailable(db, scope);
  const skills_hook_injected = extractSkillsHookInjected(db, scope);
  const mcp_calls = extractMcpCalls(db, scope);
  const web_fetches = extractWebFetches(db, scope);
  const git_operations = extractGitOperations(db, scope);
  const todo_events = extractTodoEvents(db, scope);
  const user_interruptions = extractUserInterruptions(db, scope);
  // Corpus-aggregate: parent/child linkage spans sessions, so always full.
  const subagent_invocations = extractSubagentInvocations(db);
  const user_corrections = extractUserCorrections(db, scope);
  // Corpus-aggregate: sequence/template frequencies span the whole corpus.
  const tool_call_ngrams = extractToolCallNgrams(db);
  const prompt_templates = extractPromptTemplates(db);
  const friction_events = extractFrictionEvents(db, scope);
  const self_resolutions = extractSelfResolutions(db, scope);
  const search_calls = extractSearchCalls(db, scope);
  // Derives workflow_runs / workflow_agents / workflow_run_phases from the raw
  // workflow tables (populated by normalize); resolves session links against
  // the sessions already present.
  const workflow_runs = extractWorkflowRuns(db);

  // Post-extract passes that depend on fact tables being fully populated.
  const commit_status = extractCommitStatus(db, scope);
  // Populate has_subagents / subagent_count from child sessions. A newly
  // (re)imported child can change its parent's counts even when the parent
  // is not itself in scope, so this rollup always spans the whole corpus.
  // Using sessions.parent_session_id (not subagent_invocations) so CC subagents
  // linked via filesystem are counted even when no Task tool call was recorded.
  db.prepare(
    `UPDATE sessions SET
       subagent_count = (SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = sessions.id),
       has_subagents  = CASE WHEN (SELECT COUNT(*) FROM sessions c WHERE c.parent_session_id = sessions.id) > 0 THEN 1 ELSE 0 END`,
  ).run();

  return {
    files_touched,
    shell_commands,
    tool_errors,
    user_corrections,
    skills_invoked,
    skills_available,
    skills_hook_injected,
    mcp_calls,
    web_fetches,
    git_operations,
    todo_events,
    user_interruptions,
    tool_call_ngrams,
    prompt_templates,
    friction_events,
    subagent_invocations,
    self_resolutions,
    commit_status,
    search_calls,
    workflow_runs,
  };
}
