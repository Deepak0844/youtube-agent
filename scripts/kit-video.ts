// Validate a scene file, then render it as ONE portrait MP4 inside the render image (kit-video composition).
// Needs the image: npm run image:render. Output: .data/kit-video/out.mp4
// Container rules match kit:studio: kit mounted read-only, no env or secrets, --rm. Audio is copied into a read-only public dir.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildVideoProps, parseVideoArgs } from "./kit-video-lib";

const root = path.resolve(import.meta.dirname, "..");
const args = parseVideoArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(1);
}
const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch (e) {
    console.error(`cannot read ${f}: ${(e as Error).message}`);
    process.exit(1);
  }
};
const out = path.join(root, ".data", "kit-video");
const pub = path.join(out, "public");
rmSync(pub, { recursive: true, force: true });
mkdirSync(pub, { recursive: true });
let audioSrc: string | undefined;
if (args.audio) {
  audioSrc = `narration${path.extname(args.audio).toLowerCase().replace(/[^.a-z0-9]/g, "")}`;
  try {
    copyFileSync(args.audio, path.join(pub, audioSrc));
  } catch (e) {
    console.error(`cannot read ${args.audio}: ${(e as Error).message}`);
    process.exit(1);
  }
}
const r = buildVideoProps(read(args.file), { captionsText: args.captions ? read(args.captions) : undefined, audioSrc, fps: 30 }); // fps: keep equal to remotion/kit/theme.ts
if (!r.ok) {
  console.error(`${args.file} is not valid:\n` + r.errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
writeFileSync(path.join(out, "props.json"), JSON.stringify(r.props));
try {
  execFileSync("docker", ["info"], { stdio: "ignore" });
} catch {
  console.error("Docker is not running. Start OrbStack and retry.");
  process.exit(1);
}
const browser = "--browser-executable=$REMOTION_BROWSER_EXECUTABLE --chrome-mode=headless-shell";
execFileSync(
  "docker",
  ["run", "--rm", "-v", `${path.join(root, "remotion", "kit")}:/opt/render/kit:ro`, "-v", `${pub}:/pub:ro`, "-v", `${out}:/out`, "-w", "/opt/render", "--user", "root", "--entrypoint", "sh", "ytstudio-render:dev", "-c",
   `npx remotion render kit/index.ts kit-video /out/out.mp4 --props=/out/props.json --public-dir=/pub ${browser}`],
  { stdio: "inherit" },
);
console.log("video in", path.join(out, "out.mp4"));
