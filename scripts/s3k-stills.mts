// `npm run s3k:stills`: render stills (or a short video) of the s3k kit demo with the NATIVE Mac GPU (angle), not the container.
// One render at a time (concurrency 1). Run it niced: `nice -n 19 npm run s3k:stills -- --frames 20,90`.
//   --example tunnel|reclamation   which example scene (default tunnel)
//   --frames a,b,c        frames to render as stills (default: N evenly spaced, see --n)
//   --n <count>           how many stills when --frames is not given (default 4)
//   --out <dir>           scratch folder (default: $TMPDIR/s3k-stills)
//   --scale <x>           1 = 1080x1920, 0.5 = 540x960 (default 0.5)
//   --files <dir>         the catalogue folder of .glb files (default assets3d/files in this repo, or $S3K_FILES)
//   --finish full|fast|off  the finish chain (default full; fast = no AO/DOF; off = plain render)
//   --log                 print the page console (to find scene errors)
//   --video <file.mp4>    render a video instead of stills; --range a-b limits the frames
// Needs @remotion/bundler and @remotion/renderer 4.0.542: from node_modules, or from the folder named in REMOTION_TOOLS.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { S3K_EXAMPLES, s3kFrames, type S3kExample } from "../remotion/kit/s3k/meta";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const req = createRequire(process.env.REMOTION_TOOLS ? path.join(process.env.REMOTION_TOOLS, "x.js") : path.join(root, "x.js"));
const { bundle } = req("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = req("@remotion/renderer");

const example = (opt("example") ?? "tunnel") as S3kExample;
if (!(example in S3K_EXAMPLES)) throw new Error(`unknown --example ${example} (${Object.keys(S3K_EXAMPLES).join(", ")})`);
const total = s3kFrames({ example });
const out = path.resolve(opt("out") ?? path.join(os.tmpdir(), "s3k-stills"));
mkdirSync(out, { recursive: true });
const scale = Number(opt("scale") ?? 0.5);

// The page may read only what is linked here: assets3d/files/. Never the repo root (it holds .env files).
const publicDir = await mkdtemp(path.join(os.tmpdir(), "s3k-public-"));
const files = path.resolve(opt("files") ?? process.env.S3K_FILES ?? path.join(root, "assets3d", "files"));
if (existsSync(files)) { mkdirSync(path.join(publicDir, "assets3d")); symlinkSync(files, path.join(publicDir, "assets3d", "files")); }
else console.warn(`no model files at ${files}: models will be grey stand-ins (pass --files)`);

const serveUrl = await bundle({ entryPoint: path.join(root, "remotion", "kit", "index.ts"), publicDir });
const finish = opt("finish") ?? "full"; // full | fast | off
const inputProps = { example, finish };
const composition = await selectComposition({ serveUrl, id: "S3kDemo", inputProps });
const chromiumOptions = { gl: "angle" as const };
// --log prints what the page writes to its console (errors from the scene show here).
const logLevel = args.includes("--log") ? ("verbose" as const) : undefined;
const onBrowserLog = args.includes("--log") ? (l: { type: string; text: string }) => console.log(`[page ${l.type}] ${l.text.slice(0, 400)}`) : undefined;

if (opt("video")) {
  const [a, b] = (opt("range") ?? `0-${total - 1}`).split("-").map(Number) as [number, number];
  const file = path.resolve(opt("video")!);
  mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  await renderMedia({ composition: { ...composition }, serveUrl, codec: "h264", outputLocation: file, inputProps, chromiumOptions, concurrency: 1, frameRange: [a, b], scale, overwrite: true, crf: 17, onBrowserLog });
  console.log(`video ${file}: ${((Date.now() - t0) / 1000 / (b - a + 1)).toFixed(2)} s per frame`);
} else {
  const n = Number(opt("n") ?? 4);
  const frames = opt("frames") ? opt("frames")!.split(",").map(Number) : Array.from({ length: n }, (_, i) => Math.min(total - 1, Math.round(((i + 0.5) / n) * total)));
  for (const f of frames) {
    const t0 = Date.now();
    const file = path.join(out, `still-${String(f).padStart(4, "0")}.png`);
    await renderStill({ composition, serveUrl, output: file, frame: f, inputProps, chromiumOptions, scale, overwrite: true, onBrowserLog, logLevel });
    console.log(`${file}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
