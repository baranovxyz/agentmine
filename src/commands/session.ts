import { defineCommand } from "citty";
import { Errors } from "../contract/errors.js";
import { type CommandOutcome, runCommand } from "../contract/result.js";
import { dbExists, openDb } from "../db/client.js";

type Data = Record<string, unknown>;

export const sessionCommand = defineCommand({
  meta: {
    name: "session",
    description:
      "Render one session's messages + tool_calls as JSON or markdown",
  },
  args: {
    id: {
      type: "positional",
      description: "Session id (e.g. cc--<uuid>)",
      required: true,
    },
    md: {
      type: "boolean",
      default: false,
      description: "Render markdown transcript to stdout",
    },
    head: {
      type: "string",
      description: "Include only the first N message turns",
    },
    tail: {
      type: "string",
      description: "Include only the last N message turns",
    },
    "turn-range": {
      type: "string",
      description: "Include inclusive message turn range A:B",
    },
    "show-context": {
      type: "boolean",
      default: false,
      description: "Include full tool_call outputs (default: preview only)",
    },
  },
  async run({ args }) {
    await runCommand<Data>({
      command: "agentmine session",
      handler: async (): Promise<CommandOutcome<Data>> => {
        if (!dbExists()) throw Errors.notFound("sessions.db not found.");
        const id = String(args.id ?? "");
        if (!id) throw Errors.invalidInput("session id required");
        const db = openDb({ readonly: true });
        try {
          const session = db
            .prepare<[string], Record<string, unknown>>(
              `SELECT * FROM sessions WHERE id = ?`,
            )
            .get(id);
          if (!session) throw Errors.notFound(`Session ${id} not found`);

          const messages = db
            .prepare<
              [string],
              {
                turn: number;
                role: string;
                author: string | null;
                ts: number | null;
                text: string;
              }
            >(
              `SELECT turn, role, author, ts, text FROM messages WHERE session_id = ? ORDER BY turn`,
            )
            .all(id);

          const slicedMessages = sliceMessages(messages, args);
          const retainedTurns = new Set(slicedMessages.map((msg) => msg.turn));

          const toolCalls = db
            .prepare<
              [string],
              {
                turn: number;
                idx: number;
                name: string;
                args_preview: string;
                output_preview: string | null;
                output_bytes: number | null;
                exit_code: number | null;
                duration_ms: number | null;
                call_id: string | null;
                output_text?: string;
              }
            >(
              `SELECT turn, idx, name, args_preview, output_preview, output_bytes,
                      exit_code, duration_ms, call_id
                 FROM tool_calls WHERE session_id = ? ORDER BY turn, idx`,
            )
            .all(id)
            .filter((tc) => retainedTurns.has(tc.turn));

          if (args["show-context"]) {
            const outputs = db
              .prepare<
                [string],
                { turn: number; idx: number; output_text: string }
              >(
                `SELECT turn, idx, output_text FROM tool_outputs WHERE session_id = ?`,
              )
              .all(id);
            const outputByKey = new Map(
              outputs.map((row) => [`${row.turn}:${row.idx}`, row.output_text]),
            );
            for (const tc of toolCalls) {
              const outputText = outputByKey.get(`${tc.turn}:${tc.idx}`);
              if (outputText !== undefined) tc.output_text = outputText;
            }
          }

          if (args.md) {
            const md = renderMarkdown(session, slicedMessages, toolCalls);
            // Markdown goes on stdout as a STRING payload inside the envelope,
            // so agents can still parse the envelope.
            return { data: { markdown: md } };
          }

          return {
            data: {
              session,
              messages: slicedMessages,
              tool_calls: toolCalls,
            },
          };
        } finally {
          db.close();
        }
      },
    });
  },
});

type MessageRow = {
  turn: number;
  role: string;
  author: string | null;
  ts: number | null;
  text: string;
};

function sliceMessages(
  messages: MessageRow[],
  args: Record<string, unknown>,
): MessageRow[] {
  const modes = [args.head, args.tail, args["turn-range"]].filter(
    (v) => v !== undefined && v !== null && String(v) !== "",
  );
  if (modes.length > 1) {
    throw Errors.invalidInput(
      "Use only one of --head, --tail, or --turn-range",
    );
  }
  if (
    args.head !== undefined &&
    args.head !== null &&
    String(args.head) !== ""
  ) {
    return messages.slice(0, parsePositiveInt(args.head, "--head"));
  }
  if (
    args.tail !== undefined &&
    args.tail !== null &&
    String(args.tail) !== ""
  ) {
    return messages.slice(-parsePositiveInt(args.tail, "--tail"));
  }
  if (
    args["turn-range"] !== undefined &&
    args["turn-range"] !== null &&
    String(args["turn-range"]) !== ""
  ) {
    const raw = String(args["turn-range"]);
    const match = raw.match(/^(\d+):(\d+)$/);
    if (!match)
      throw Errors.invalidInput("--turn-range must use inclusive A:B syntax");
    const start = parsePositiveInt(match[1], "--turn-range start");
    const end = parsePositiveInt(match[2], "--turn-range end");
    if (start > end)
      throw Errors.invalidInput("--turn-range start must be <= end");
    return messages.filter((msg) => msg.turn >= start && msg.turn <= end);
  }
  return messages;
}

function parsePositiveInt(value: unknown, flag: string): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw Errors.invalidInput(`${flag} must be a positive integer`);
  }
  return n;
}

function renderMarkdown(
  session: Record<string, unknown>,
  messages: Array<{
    turn: number;
    role: string;
    ts: number | null;
    text: string;
  }>,
  toolCalls: Array<{
    turn: number;
    idx: number;
    name: string;
    args_preview: string;
    output_preview: string | null;
    output_text?: string;
    output_bytes: number | null;
    exit_code: number | null;
  }>,
): string {
  const tcByTurn = new Map<number, typeof toolCalls>();
  for (const tc of toolCalls) {
    const list = tcByTurn.get(tc.turn) ?? [];
    list.push(tc);
    tcByTurn.set(tc.turn, list);
  }

  const lines: string[] = [];
  lines.push(`# Session ${session["id"]}`);
  lines.push(
    `- source: \`${session["source"]}\`  | project: \`${session["project_path"]}\`  | model: \`${session["model"]}\``,
  );
  const started = session["started_at"];
  if (typeof started === "number") {
    lines.push(`- started: ${new Date(started * 1000).toISOString()}`);
  }
  lines.push("");

  for (const msg of messages) {
    const hdr = msg.ts
      ? `## ${msg.role} (turn ${msg.turn}, ${new Date(msg.ts * 1000).toISOString()})`
      : `## ${msg.role} (turn ${msg.turn})`;
    lines.push(hdr);
    if (msg.text) lines.push(msg.text);
    const tcs = tcByTurn.get(msg.turn);
    if (tcs && tcs.length > 0) {
      for (const tc of tcs) {
        lines.push("");
        lines.push(
          `> **[${tc.name}]** \`${tc.args_preview.slice(0, 120)}\` → exit=${tc.exit_code ?? "?"}, bytes=${tc.output_bytes ?? "?"}`,
        );
        const output = tc.output_text ?? tc.output_preview;
        if (output) {
          lines.push("```");
          lines.push(output.slice(0, 1000));
          lines.push("```");
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
