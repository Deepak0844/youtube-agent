// Validate a scene JSON file, then render frame 0 / middle / last of each scene inside the render image.
// Needs the image: npm run image:render. Output: .data/kit-preview/
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, planPreview } from "./kit-preview-lib";

const root = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(1);
}
let text: string;
try {
  text = readFileSync(args.file, "utf8");
} catch (e) {
  console.error(`cannot read ${args.file}: ${(e as Error).message}`);
  process.exit(1);
}
const plan = planPreview(text);
if (!plan.ok) {
  console.error(`${args.file} is not a valid scene file:\n` + plan.errors.map((e: string) => `  - ${e}`).join("\n"));
  process.exit(1);
}
plan.skipped.forEach((s) => console.warn("skipped:", s));
if (!plan.plans.length) process.exit(1);

const out = path.join(root, ".data", "kit-preview");
mkdirSync(out, { recursive: true });
const browser = "--browser-executable=$REMOTION_BROWSER_EXECUTABLE --chrome-mode=headless-shell";
const cmds = plan.plans.flatMap((p) => {
  writeFileSync(path.join(out, `${p.id}.props.json`), JSON.stringify({ scene: p.scene }));
  return p.frames.map((f) => `npx remotion still kit/index.ts kit-scene /out/${p.id}-${f}.png --props=/out/${p.id}.props.json --frame=${f} ${browser}`);
});
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Start OrbStack and retry.");
  process.exit(1);
}
execFileSync(
  "docker",
  ["run", "--rm", "-v", `${path.join(root, "remotion", "kit")}:/opt/render/kit:ro`, "-v", `${out}:/out`, "-w", "/opt/render", "--user", "root", "--entrypoint", "sh", "ytstudio-render:dev", "-c", cmds.join(" && ")],
  { stdio: "inherit" },
);
console.log("stills in", out);
