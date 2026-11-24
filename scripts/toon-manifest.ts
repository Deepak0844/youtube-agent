// Dev script: copies the cartoon-shorts references into engine-kit/cartoon-shorts and rewrites MANIFEST.json
// (upstream commit, every file copied from upstream, its upstream sha256, and whether the local copy was patched).
//   npx tsx scripts/toon-manifest.ts [~/Personal/test-work/cartoon-shorts]
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const up = path.resolve((process.argv[2] ?? "~/Personal/test-work/cartoon-shorts").replace(/^~/, os.homedir()));
const root = path.resolve(__dirname, "..");
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
const files: { path: string; sha256: string; patched: boolean }[] = [];
const add = (from: string, to: string) => {
  mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  copyFileSync(path.join(up, from), path.join(root, to));
  files.push({ path: to, sha256: sha(path.join(up, from)), patched: false });
};
copyFileSync(path.join(up, "LICENSE"), path.join(root, "engine-kit/cartoon-shorts/LICENSE"));
for (const f of readdirSync(path.join(up, "references")).filter((n) => n.endsWith(".md"))) add(`references/${f}`, `engine-kit/cartoon-shorts/ref/${f}`);
for (const f of readdirSync(path.join(up, "references/styles"))) add(`references/styles/${f}`, `engine-kit/cartoon-shorts/ref/styles/${f}`);
// Kit copies (remotion/kit/toon/upstream): the file is kept as is unless a line was changed on purpose (marked "yt-toon patch:").
const KIT: [string, string][] = [
  ["engine/core.js", "core.js"], ["engine/core.css", "core.css"], ["engine/styles/fx.js", "fx.js"], ["engine/styles/toon.js", "toon.js"],
  ...["anime", "manga", "paper", "painted"].map((s): [string, string] => [`engine/styles/${s}.js`, `${s}.js`]),
];
for (const [from, name] of KIT) {
  const to = `remotion/kit/toon/upstream/${name}`;
  if (!existsSync(path.join(root, to))) continue;
  files.push({ path: to, sha256: sha(path.join(up, from)), patched: sha(path.join(root, to)) !== sha(path.join(up, from)) });
}
const commit = execFileSync("git", ["-C", up, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(path.join(root, "engine-kit/cartoon-shorts/MANIFEST.json"), JSON.stringify({ upstream: "https://github.com/Matteoikarieth96/cartoon-shorts", commit, files }, null, 2) + "\n");
console.log(`manifest: ${files.length} files, upstream ${commit.slice(0, 7)}`);
