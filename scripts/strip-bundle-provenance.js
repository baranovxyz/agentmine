import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, "dist");

for (const entry of await readdir(distDir, { withFileTypes: true })) {
  if (!(entry.isFile() && entry.name.endsWith(".js"))) continue;
  const path = join(distDir, entry.name);
  const source = await readFile(path, "utf8");
  const scrubbed = source.replace(/^\/\/ \.\.\/.*$/gmu, "// bundled module");
  await writeFile(path, scrubbed);
}
