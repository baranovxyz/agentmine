import { describe, expect, it } from "vitest";
import {
  buildServiceDefinition,
  currentServiceKind,
} from "../src/daemon/service.js";

const INVOCATION = {
  command: "/usr/bin/node",
  args: ["/opt/agentmine/cli.js", "daemon", "--only", "codex"],
};

describe("service definitions", () => {
  it("picks the service manager the platform actually has", () => {
    expect(currentServiceKind("linux")).toBe("systemd");
    expect(currentServiceKind("darwin")).toBe("launchd");
    expect(currentServiceKind("win32")).toBeUndefined();
  });

  it("writes a systemd user unit that runs the configured command", () => {
    const def = buildServiceDefinition("systemd", INVOCATION, "/home/dev");

    expect(def.path).toBe(
      "/home/dev/.config/systemd/user/agentmine-daemon.service",
    );
    expect(def.contents).toContain(
      "ExecStart=/usr/bin/node /opt/agentmine/cli.js daemon --only codex",
    );
    expect(def.contents).toContain("WantedBy=default.target");
  });

  it("restarts a failed daemon but backs off", () => {
    // A daemon that dies takes corpus freshness with it silently, so it must
    // come back — but a corpus that refuses to open fails identically every
    // time, and a tight loop turns one broken install into a busy machine.
    const def = buildServiceDefinition("systemd", INVOCATION, "/home/dev");
    expect(def.contents).toContain("Restart=on-failure");
    expect(/RestartSec=(\d+)/.exec(def.contents)?.[1]).toBe("30");
  });

  it("quotes systemd arguments containing spaces", () => {
    // systemd splits ExecStart on whitespace, so an unquoted home directory
    // with a space in it silently becomes two arguments.
    const def = buildServiceDefinition(
      "systemd",
      { command: "/usr/bin/node", args: ["/home/my dev/cli.js", "daemon"] },
      "/home/my dev",
    );
    expect(def.contents).toContain('"/home/my dev/cli.js"');
  });

  it("tells the operator to enable lingering, or the service dies at logout", () => {
    const def = buildServiceDefinition("systemd", INVOCATION, "/home/dev");
    expect(def.enableCommands.join(" ")).toContain("enable-linger");
  });

  it("writes a launchd agent that runs at load", () => {
    const def = buildServiceDefinition("launchd", INVOCATION, "/Users/dev");

    expect(def.path).toBe(
      "/Users/dev/Library/LaunchAgents/io.agentmine.daemon.plist",
    );
    expect(def.contents).toContain("<string>io.agentmine.daemon</string>");
    expect(def.contents).toContain("<string>/opt/agentmine/cli.js</string>");
    expect(def.contents).toContain("<key>RunAtLoad</key>");
  });

  it("keeps launchd from resurrecting a daemon stopped on purpose", () => {
    // A bare KeepAlive also restarts a clean exit, so stopping the daemon by
    // hand would bring it straight back.
    const def = buildServiceDefinition("launchd", INVOCATION, "/Users/dev");
    const keepAlive = def.contents.slice(
      def.contents.indexOf("<key>KeepAlive</key>"),
    );
    expect(keepAlive).toContain("<key>SuccessfulExit</key>");
    expect(keepAlive).toContain("<false/>");
  });

  it("escapes XML in launchd paths", () => {
    const def = buildServiceDefinition(
      "launchd",
      { command: "/bin/node", args: ["/tmp/a&b/cli.js", "daemon"] },
      "/Users/dev",
    );
    expect(def.contents).toContain("/tmp/a&amp;b/cli.js");
    expect(def.contents).not.toContain("/tmp/a&b/cli.js");
  });

  it("offers a way back out for both managers", () => {
    for (const kind of ["systemd", "launchd"] as const) {
      const def = buildServiceDefinition(kind, INVOCATION, "/home/dev");
      expect(def.disableCommands.length).toBeGreaterThan(0);
    }
  });
});
