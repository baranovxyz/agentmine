/**
 * Service definitions, so the daemon can outlive a terminal.
 *
 * The daemon runs in the foreground on purpose — supervision belongs to
 * whatever the machine already trusts to restart things, not to a hand-rolled
 * fork-and-detach. That leaves every user writing the same unit file by hand
 * and getting the same details wrong, so this generates it.
 *
 * What is deliberately NOT done here: enabling or starting the service. Writing
 * a file into a directory the user owns is easy to inspect and undo; enrolling
 * something into their init system without asking is not. The commands to do it
 * are printed instead, so the last step stays theirs.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ServiceKind } from "../db/supervision.js";

export type { ServiceKind };

export interface ServiceDefinition {
  kind: ServiceKind;
  /** Where the definition belongs. */
  path: string;
  contents: string;
  /** What the operator runs to enable it, in order. */
  enableCommands: string[];
  /**
   * What the operator runs to undo it, in order.
   *
   * Ends by deleting the definition, not merely disabling the service. The
   * file is what records that this corpus is meant to be continuously fed, so
   * leaving it behind would have reads keep reporting an absent daemon after
   * the operator had deliberately stopped it.
   */
  disableCommands: string[];
}

export interface ServiceInvocation {
  command: string;
  args: string[];
}

export function currentServiceKind(
  osPlatform: string = platform(),
): ServiceKind | undefined {
  if (osPlatform === "linux") return "systemd";
  if (osPlatform === "darwin") return "launchd";
  return undefined;
}

const SYSTEMD_UNIT_NAME = "agentmine-daemon.service";
const LAUNCHD_LABEL = "io.agentmine.daemon";

export function buildServiceDefinition(
  kind: ServiceKind,
  invocation: ServiceInvocation,
  home: string = homedir(),
): ServiceDefinition {
  return kind === "systemd"
    ? systemdUnit(invocation, home)
    : launchdAgent(invocation, home);
}

function systemdUnit(
  invocation: ServiceInvocation,
  home: string,
): ServiceDefinition {
  const execStart = [invocation.command, ...invocation.args]
    .map(quoteForSystemd)
    .join(" ");
  const contents = [
    "[Unit]",
    "Description=Agentmine corpus ingest daemon",
    "Documentation=https://agentmine.io",
    // The corpus lives in the user's home, which on a networked home directory
    // is not guaranteed mounted when the user manager starts.
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    // A daemon that dies takes corpus freshness with it silently, so restart —
    // but back off, because a corpus that refuses to open will fail every time
    // and a tight loop turns one broken install into a busy machine.
    "Restart=on-failure",
    "RestartSec=30",
    // Importing is background work by definition; it must never compete with
    // the editors and agents whose sessions it is importing.
    "Nice=10",
    "IOSchedulingClass=idle",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  const path = join(home, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
  return {
    kind: "systemd",
    path,
    contents,
    enableCommands: [
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`,
      // Without lingering, a user service stops at logout and the corpus goes
      // stale exactly when the machine is idle enough to catch up.
      `loginctl enable-linger ${process.env.USER ?? "$USER"}`,
    ],
    disableCommands: [
      `systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`,
      `rm ${path}`,
      "systemctl --user daemon-reload",
    ],
  };
}

function launchdAgent(
  invocation: ServiceInvocation,
  home: string,
): ServiceDefinition {
  const programArguments = [invocation.command, ...invocation.args]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  const logPath = join(home, "Library", "Logs", "agentmine-daemon.log");
  const contents = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    // Restart on failure only. Without the SuccessfulExit=false qualifier,
    // launchd also restarts a clean shutdown, so stopping the daemon by hand
    // would bring it straight back.
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    // Background work: let the scheduler treat it as such.
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>LowPriorityIO</key>",
    "  <true/>",
    "  <key>Nice</key>",
    "  <integer>10</integer>",
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  const path = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  return {
    kind: "launchd",
    path,
    contents,
    enableCommands: [
      `launchctl bootstrap gui/$(id -u) ${path}`,
      `launchctl enable gui/$(id -u)/${LAUNCHD_LABEL}`,
    ],
    disableCommands: [
      `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
      `rm ${path}`,
    ],
  };
}

/**
 * systemd splits `ExecStart` on whitespace, so an argument containing a space
 * — a home directory with one, most often — must be quoted or it silently
 * becomes two arguments.
 */
function quoteForSystemd(value: string): string {
  if (!/[\s"']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
