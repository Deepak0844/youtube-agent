// One still (frame 60) of every kit composition, then ffmpeg tiles them (6 per row, registry order) into .data/kit-sheet/contact-sheet.png.
// This ffmpeg has no drawtext and in-container chrome screenshots hang, so captions live in .data/kit-sheet/index.html (same order).
// Same container rules as kit:studio: kit mounted read-only, no env, --rm. Needs the image: npm run image:render.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { registryIds, sheetHtml } from "./kit-sheet-html.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, ".data", "kit-sheet");
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Start OrbStack and retry.");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const ids = registryIds(readFileSync(path.join(root, "remotion", "kit", "registry.tsx"), "utf8"));
writeFileSync(path.join(out, "index.html"), sheetHtml(ids));
const chrome = "--browser-executable=$REMOTION_BROWSER_EXECUTABLE --chrome-mode=headless-shell";
const stills = ids.map((id) => `npx remotion still kit/index.ts ${id} /out/${id}.png --frame=60 ${chrome} || echo FAILED ${id}`).join("; ");
execFileSync(
  "docker",
  ["run", "--rm", "-v", `${path.join(root, "remotion", "kit")}:/opt/render/kit:ro`, "-v", `${out}:/out`, "-w", "/opt/render", "--user", "root", "--entrypoint", "sh", "ytstudio-render:dev", "-c", stills],
  { stdio: "inherit" },
);
const have = ids.filter((id) => existsSync(path.join(out, `${id}.png`)));
const list = path.join(out, "list.txt");
writeFileSync(list, have.map((id) => `file '${id}.png'`).join("\n"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `scale=270:480,tile=6x${Math.ceil(have.length / 6)}:padding=8:color=0x111111`, "-frames:v", "1", path.join(out, "contact-sheet.png")], { stdio: "inherit" });
console.log(have.map((id, i) => `${Math.floor(i / 6) + 1}.${(i % 6) + 1} ${id}`).join("\n"));
console.log(`${have.length}/${ids.length} rendered. Sheet: ${path.join(out, "contact-sheet.png")}`);
