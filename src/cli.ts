#!/usr/bin/env node

// Early Node 24 releases report the built-in SQLite module as experimental.
// Install the exact-warning filter before loading the command graph: static
// imports would evaluate node:sqlite before this bootstrap body could run.
const warningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (
    warning.name === "ExperimentalWarning" &&
    warning.message ===
      "SQLite is an experimental feature and might change at any time"
  ) {
    return;
  }
  for (const listener of warningListeners) listener(warning);
});

await import("./main.js");

export {};
