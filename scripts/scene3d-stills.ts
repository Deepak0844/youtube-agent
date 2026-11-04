// `npm run scene3d:stills`: render look-check stills (or a short video) of a scene format v2 file with the NATIVE Mac GPU (angle), not the container.
// One render at a time (concurrency 1). Run it niced: `nice -n 19 npm run scene3d:stills -- --frames 20,90`.
//   --scene <file.json>   scene to render (default: the demo scene in remotion/kit/scene3d/demo-scene.ts)
//   --frames a,b,c        frames to render as stills (default: N evenly spaced, see --n)
//   --n <count>           how many stills when --frames is not given (default 4)
//   --out <dir>           scratch folder (default: $TMPDIR/scene3d-stills)
//   --scale <x>           1 = 1080x1920, 0.5 = 540x960 (default 0.5)
//   --models <dir>        folder of .glb files served to the scene as models/<name>.glb
//   --video <file.mp4>    render a video instead of stills; --range a-b limits the frames
// Needs @remotion/bundler and @remotion/renderer 4.0.538: from node_modules, or from the folder named in REMOTION_TOOLS.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scene3dSchema } from "../src/shared/scene3d/schema";
import { SCENE3D_DEMO } from "../remotion/kit/scene3d/demo-scene";
import { scene3dFrames } from "../remotion/kit/scene3d/camera";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

const req = createRequire(process.env.REMOTION_TOOLS ? path.join(process.env.REMOTION_TOOLS, "x.js") : path.join(root, "x.js"));
const { bundle } = req("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = req("@remotion/renderer");

const raw = opt("scene") ? JSON.parse(await readFile(path.resolve(opt("scene")!), "utf8")) : SCENE3D_DEMO;
const scene = scene3dSchema.parse(raw);
const total = scene3dFrames(scene);
const out = path.resolve(opt("out") ?? path.join(os.tmpdir(), "scene3d-stills"));
mkdirSync(out, { recursive: true });
const scale = Number(opt("scale") ?? 0.5);

// The page may read only what is linked here: models/ (the --models folder) and assets3d/files/. Never the repo root (it holds .env files).
const publicDir = await mkdtemp(path.join(os.tmpdir(), "scene3d-public-"));
if (opt("models")) symlinkSync(path.resolve(opt("models")!), path.join(publicDir, "models"));
const files = path.join(root, "assets3d", "files");
if (existsSync(files)) { mkdirSync(path.join(publicDir, "assets3d")); symlinkSync(files, path.join(publicDir, "assets3d", "files")); }

const serveUrl = await bundle({ entryPoint: path.join(root, "remotion", "kit", "index.ts"), publicDir });
const inputProps = { scene };
const composition = await selectComposition({ serveUrl, id: "scene3d", inputProps });
const chromiumOptions = { gl: "angle" as const };

if (opt("video")) {
  const [a, b] = (opt("range") ?? `0-${total - 1}`).split("-").map(Number) as [number, number];
  const file = path.resolve(opt("video")!);
  mkdirSync(path.dirname(file), { recursive: true });
  const t0 = Date.now();
  await renderMedia({ composition: { ...composition }, serveUrl, codec: "h264", outputLocation: file, inputProps, chromiumOptions, concurrency: 1, frameRange: [a, b], scale, overwrite: true, crf: 17 });
  console.log(`video ${file}: ${((Date.now() - t0) / 1000 / (b - a + 1)).toFixed(2)} s per frame`);
} else {
  const n = Number(opt("n") ?? 4);
  const frames = opt("frames") ? opt("frames")!.split(",").map(Number) : Array.from({ length: n }, (_, i) => Math.min(total - 1, Math.round(((i + 0.5) / n) * total)));
  for (const f of frames) {
    const t0 = Date.now();
    const file = path.join(out, `still-${String(f).padStart(4, "0")}.png`);
    await renderStill({ composition, serveUrl, output: file, frame: f, inputProps, chromiumOptions, scale, overwrite: true });
    console.log(`${file}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
