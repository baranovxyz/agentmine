import type { Command, Node } from "unbash";
import { parse } from "unbash";

/**
 * The shared shell-parse seam for fact extractors.
 *
 * Every extractor that derives a fact from `shell_commands.cmd_full` reads the
 * command through this module rather than matching text within it, so that the
 * two rules that make those facts trustworthy are stated once:
 *
 *   1. A parse error means NO facts. An unterminated quote, a malformed
 *      heredoc, or a parser throw yields zero commands rather than a partial
 *      or guessed reading. A fact table would rather be missing a row than
 *      carry one describing a command that never ran.
 *   2. The reachable scope is bounded and deliberate. Only top-level commands
 *      and those joined by `&&`, `||`, `;`, and `|` are reached. Subshells,
 *      brace groups, loop and conditional bodies, function bodies, and
 *      anything nested inside a word (command substitution, heredoc body) are
 *      NOT descended into -- widening the walk also reaches data positions
 *      such as heredoc bodies, which is where phantom rows came from, so it
 *      must be validated against phantom attribution before it changes.
 */

/**
 * Parse `cmd` as shell, or return `null` if it cannot be read with certainty.
 *
 * A reported syntax error is treated the same as a throw: both mean the parse
 * is not a faithful reading of the command, and callers must derive nothing.
 */
export function parseShellCommand(
  cmd: string,
): ReturnType<typeof parse> | null {
  let script: ReturnType<typeof parse>;
  try {
    script = parse(cmd);
  } catch {
    return null;
  }
  if (script.errors && script.errors.length > 0) return null;
  return script;
}

/**
 * Every command node `cmd` reaches, in source order.
 *
 * Returns an empty array for an unparseable command, which is indistinguishable
 * to callers from a command that runs nothing -- both correctly yield no facts.
 */
export function reachableCommands(cmd: string): Command[] {
  const script = parseShellCommand(cmd);
  if (!script) return [];
  const found: Command[] = [];
  for (const statement of script.commands)
    collectCommands(statement.command, found);
  found.sort((a, b) => a.pos - b.pos);
  return found;
}

function collectCommands(node: Node, out: Command[]): void {
  switch (node.type) {
    case "Command":
      out.push(node);
      return;
    case "Pipeline":
    case "AndOr":
      for (const child of node.commands) collectCommands(child, out);
      return;
    default:
      return;
  }
}

/**
 * A command's argv as the shell would pass it: the command word followed by its
 * already-dequoted operands.
 *
 * Assignment prefixes are absent by construction -- unbash reports them in
 * `prefix`, not in `name`/`suffix` -- so a leading `VAR=value` never masks the
 * command word the way a whitespace split does.
 */
export function commandArgv(command: Command): string[] {
  const argv: string[] = [];
  if (command.name !== undefined) argv.push(command.name.value);
  for (const word of command.suffix) argv.push(word.value);
  return argv;
}
