import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    lib: "src/lib.ts",
  },
  format: ["esm"],
  // node:sqlite (the storage layer) requires Node >= 22.5; package engines pins >= 24.
  target: "node22",
  platform: "node",
  clean: true,
  dts: false,
  sourcemap: false,
  /**
   * tsup defaults `removeNodeProtocol` to true, which rewrites `node:sqlite` →
   * bare `sqlite` in the output — the published CLI then dies at runtime with
   * "Cannot find package 'sqlite'" (the experimental builtin has no bare alias).
   * Keep the `node:` prefix so the built artifact imports the real builtin.
   */
  removeNodeProtocol: false,
  /**
   * Bundle agent-canonical so globally installed CLI and library entrypoints
   * are self-contained at runtime.
   */
  noExternal: ["agent-canonical"],
});
