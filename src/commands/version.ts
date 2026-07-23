import { defineCommand } from "citty";
import { runCommand } from "../contract/result.js";
import { getRuntimeInfo } from "../runtime.js";
import { VERSION } from "../version.js";

export const versionCommand = defineCommand({
  meta: {
    name: "version",
    description: "Report Agentmine and runtime build metadata",
  },
  async run() {
    await runCommand({
      command: "agentmine version",
      handler: () => ({
        data: {
          agentmine_version: VERSION,
          ...getRuntimeInfo(),
        },
      }),
    });
  },
});
