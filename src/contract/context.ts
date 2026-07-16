import { isCI } from "ci-info";

export type ExecutionContext = "interactive" | "ci" | "agent";

export interface ContextInfo {
  context: ExecutionContext;
  stdoutTty: boolean;
  stderrTty: boolean;
  isCI: boolean;
  color: boolean;
  json: boolean;
  prompts: boolean;
}

export function detectContext(): ContextInfo {
  const stdoutTty = Boolean(process.stdout.isTTY);
  const stderrTty = Boolean(process.stderr.isTTY);
  let ctx: ExecutionContext;
  if (stdoutTty && stderrTty) ctx = "interactive";
  else if (isCI) ctx = "ci";
  else ctx = "agent";

  const noColor = Boolean(process.env.NO_COLOR);
  return {
    context: ctx,
    stdoutTty,
    stderrTty,
    isCI,
    color: ctx === "interactive" && !noColor,
    json: ctx !== "interactive",
    prompts: ctx === "interactive",
  };
}
