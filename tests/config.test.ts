import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAppDataRoot,
  resolveClineSessionsPath,
  resolveGooseDbCandidates,
  resolveGooseDbPath,
} from "../src/config.js";

describe("data paths", () => {
  it("uses XDG data paths on macOS and other Unix platforms", () => {
    expect(
      resolveAppDataRoot({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
      }),
    ).toBe(posix.join("/Users/alice", ".local", "share", "agentmine"));

    expect(
      resolveAppDataRoot({
        platform: "linux",
        home: "/home/alice",
        env: { XDG_DATA_HOME: "/var/data" },
      }),
    ).toBe(posix.join("/var/data", "agentmine"));
  });

  it("ignores relative XDG data paths", () => {
    expect(
      resolveAppDataRoot({
        platform: "linux",
        home: "/home/alice",
        env: { XDG_DATA_HOME: "relative/data" },
      }),
    ).toBe(posix.join("/home/alice", ".local", "share", "agentmine"));
  });

  it("uses Windows roaming AppData", () => {
    expect(
      resolveAppDataRoot({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
      }),
    ).toBe(win32.join("C:\\Users\\Alice\\AppData\\Roaming", "agentmine"));
  });

  it("resolves the Goose database from the Linux data directory", () => {
    expect(
      resolveGooseDbPath({
        platform: "linux",
        home: "/home/alice",
        env: {},
        pathExists: () => false,
      }),
    ).toBe("/home/alice/.local/share/goose/sessions/sessions.db");

    expect(
      resolveGooseDbPath({
        platform: "linux",
        home: "/home/alice",
        env: { XDG_DATA_HOME: "/var/data" },
        pathExists: () => false,
      }),
    ).toBe("/var/data/goose/sessions/sessions.db");

    expect(
      resolveGooseDbPath({
        platform: "linux",
        home: "/home/alice",
        env: { XDG_DATA_HOME: "relative/data" },
        pathExists: () => false,
      }),
    ).toBe("/home/alice/.local/share/goose/sessions/sessions.db");
  });

  it("uses the current Goose XDG data directory on macOS", () => {
    expect(
      resolveGooseDbPath({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
        pathExists: () => false,
      }),
    ).toBe("/Users/alice/.local/share/goose/sessions/sessions.db");

    expect(
      resolveGooseDbPath({
        platform: "darwin",
        home: "/Users/alice",
        env: { XDG_DATA_HOME: "/var/data" },
        pathExists: () => false,
      }),
    ).toBe("/var/data/goose/sessions/sessions.db");
  });

  it("falls back to the existing legacy Goose macOS data directory", () => {
    const legacyPath =
      "/Users/alice/Library/Application Support/Block/goose/data/sessions/sessions.db";
    expect(
      resolveGooseDbPath({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
        pathExists: (candidate) => candidate === legacyPath,
      }),
    ).toBe(legacyPath);

    expect(
      resolveGooseDbCandidates({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
      }),
    ).toEqual([
      "/Users/alice/.local/share/goose/sessions/sessions.db",
      legacyPath,
    ]);

    expect(
      resolveGooseDbPath({
        platform: "darwin",
        home: "/Users/alice",
        env: {},
        pathExists: () => true,
      }),
    ).toBe("/Users/alice/.local/share/goose/sessions/sessions.db");
  });

  it("uses the native Goose data directory on Windows", () => {
    expect(
      resolveGooseDbPath({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
        pathExists: () => false,
      }),
    ).toBe(
      "C:\\Users\\Alice\\AppData\\Roaming\\Block\\goose\\data\\sessions\\sessions.db",
    );

    expect(
      resolveGooseDbPath({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: {},
        pathExists: () => false,
      }),
    ).toBe(
      "C:\\Users\\Alice\\AppData\\Roaming\\Block\\goose\\data\\sessions\\sessions.db",
    );
  });

  it("gives GOOSE_PATH_ROOT precedence and uses its data subdirectory", () => {
    expect(
      resolveGooseDbPath({
        platform: "linux",
        home: "/home/alice",
        env: {
          GOOSE_PATH_ROOT: "/tmp/isolated-goose",
          XDG_DATA_HOME: "/var/data",
        },
        pathExists: () => false,
      }),
    ).toBe("/tmp/isolated-goose/data/sessions/sessions.db");

    expect(
      resolveGooseDbPath({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: {
          APPDATA: "C:\\Users\\Alice\\AppData\\Roaming",
          GOOSE_PATH_ROOT: "D:\\isolated-goose",
        },
        pathExists: () => false,
      }),
    ).toBe("D:\\isolated-goose\\data\\sessions\\sessions.db");
  });

  it("preserves a non-empty relative GOOSE_PATH_ROOT like Goose", () => {
    expect(
      resolveGooseDbCandidates({
        platform: "linux",
        home: "/home/alice",
        env: { GOOSE_PATH_ROOT: "isolated-goose" },
      }),
    ).toEqual(["isolated-goose/data/sessions/sessions.db"]);
  });

  it("ignores an empty GOOSE_PATH_ROOT", () => {
    expect(
      resolveGooseDbPath({
        platform: "linux",
        home: "/home/alice",
        env: { GOOSE_PATH_ROOT: "" },
        pathExists: () => false,
      }),
    ).toBe("/home/alice/.local/share/goose/sessions/sessions.db");
  });

  it("resolves the default Cline session directory on Unix and Windows", () => {
    expect(
      resolveClineSessionsPath({
        platform: "linux",
        home: "/home/alice",
        env: {},
      }),
    ).toBe("/home/alice/.cline/data/sessions");

    expect(
      resolveClineSessionsPath({
        platform: "win32",
        home: "C:\\Users\\Alice",
        env: {},
      }),
    ).toBe("C:\\Users\\Alice\\.cline\\data\\sessions");
  });

  it("matches Cline's session, data, then root override precedence", () => {
    expect(
      resolveClineSessionsPath({
        platform: "linux",
        home: "/home/alice",
        env: {
          CLINE_SESSION_DATA_DIR: " /var/cline-sessions ",
          CLINE_DATA_DIR: "/var/cline-data",
          CLINE_DIR: "/var/cline",
        },
      }),
    ).toBe("/var/cline-sessions");

    expect(
      resolveClineSessionsPath({
        platform: "linux",
        home: "/home/alice",
        env: {
          CLINE_SESSION_DATA_DIR: "",
          CLINE_DATA_DIR: "/var/cline-data",
          CLINE_DIR: "/var/cline",
        },
      }),
    ).toBe("/var/cline-data/sessions");

    expect(
      resolveClineSessionsPath({
        platform: "linux",
        home: "/home/alice",
        env: {
          CLINE_SESSION_DATA_DIR: " ",
          CLINE_DATA_DIR: " ",
          CLINE_DIR: "/var/cline",
        },
      }),
    ).toBe("/var/cline/data/sessions");
  });

  it("preserves relative Cline overrides like Cline", () => {
    expect(
      resolveClineSessionsPath({
        platform: "linux",
        home: "/home/alice",
        env: { CLINE_DATA_DIR: "isolated-cline" },
      }),
    ).toBe("isolated-cline/sessions");
  });
});
