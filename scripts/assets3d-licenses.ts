import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderLicenses } from "@/shared/assets3d/licenses";
import { Manifest } from "@/shared/assets3d/schema";

// npm run assets3d:licenses  rewrites assets3d/LICENSES.md from assets3d/manifest.json
async function main(): Promise<void> {
  const root = path.join(process.cwd(), "assets3d");
  const { entries } = Manifest.parse(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  await writeFile(path.join(root, "LICENSES.md"), renderLicenses(entries));
  process.stdout.write(`wrote LICENSES.md for ${entries.length} entries\n`);
}
void main();
