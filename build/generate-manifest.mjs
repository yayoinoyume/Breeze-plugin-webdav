import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginInfo } from "../src/plugin-info.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function main() {
  const manifest = buildPluginInfo();
  const target = resolve(rootDir, "manifest.json");
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  console.log(`[manifest] generated: ${target}`);
}

await main();
