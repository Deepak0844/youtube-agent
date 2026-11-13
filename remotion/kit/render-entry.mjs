// Runs INSIDE the render container only (src/server/providers/renderer/remotion-container.ts starts it): node as a
// non-root user, --network none, read-only root, this kit mounted read-only at /opt/render/kit.
// usage: node /opt/render/kit/render-entry.mjs <inDir> <outFile>                 the scene kit (props.json)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --landscape     the 1920x1080 long-form scene kit, composition kit-video-landscape (props.json: the kit props plus chapters)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --landscape --frames=<from>-<to|end> [--muted]   one chapter of that render: frames from..to (inclusive, "end" = the last frame) of the SAME composition, so cards, progress and captions stay right; --muted leaves the sound out (the host joins the chapters and the voice step lays the narration on)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --thumbnail   the 1280x720 long-video thumbnail card, composition thumbnail, ONE png at <outFile> (props.json: title, seed, optional src = a staged picture in <inDir>); no extra arguments
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --tsx           one checked TSX file (video.tsx)
//        node /opt/render/kit/render-entry.mjs <inDir> <outDir> --tsx-stills     its preflight stills (still-<n>.png)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --om            an OpenMontage scene list (props.json) drawn by OpenMontage's Explainer composition (om/)
//        node /opt/render/kit/render-entry.mjs <inDir> <outDir> --om-stills      chosen frames of it (still-<n>.png)
// Kit mode: <inDir> (read-only) holds props.json (built and validated on the host) plus the staged narration and asset
// files, served as the public dir. TSX modes: <inDir> holds video.tsx (statically checked and type-checked on the host),
// props.json, meta.json ({ durationInFrames, stills }) and public/ (the staged staticFile() files, the only public dir).
// OM modes: <inDir> holds props.json (the scene list), meta.json ({ orientation: "landscape"|"portrait", stills }) and public/.
// Portrait overrides the composition's size to 1080x1920, as OpenMontage's own render does (--width/--height of its profile).
// The TSX bundle's entry is tsx-index.ts, which imports nothing of the kit; the scene and the yt-kit library are reached through webpack aliases.
// Prints "PROGRESS <0-100>" lines; the host turns them into stage log lines.
// ESM import ignores NODE_PATH; createRequire honours it (/opt/render/node_modules in the image).
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = require("@remotion/renderer");

const [inDir, outArg, mode = "kit", ...extra] = process.argv.slice(2);
// Only "--landscape" may carry a chunk: exactly "--frames=<from>-<to|end>" and then optionally "--muted". Nothing else.
const CHUNK = /^--frames=(\d{1,7})-(\d{1,7}|end)$/.exec(extra[0] ?? "");
const chunkArgs = mode === "--landscape" && CHUNK !== null && (extra.length === 1 || (extra.length === 2 && extra[1] === "--muted"));
const chunk = chunkArgs ? { from: Number(CHUNK[1]), to: CHUNK[2] === "end" ? "end" : Number(CHUNK[2]), muted: extra.length === 2 } : null;
if (!inDir || !outArg || !path.isAbsolute(inDir) || !path.isAbsolute(outArg) || (extra.length > 0 && !chunkArgs) || !["kit", "--landscape", "--thumbnail", "--tsx", "--tsx-stills", "--om", "--om-stills"].includes(mode)) {
  throw new Error("usage: render-entry.mjs <abs inDir> <abs out> [--tsx | --tsx-stills | --om | --om-stills]");
}
// Only the two TSX modes use meta.json, video.tsx and the TSX bundle.
const tsx = mode === "--tsx" || mode === "--tsx-stills";
const om = mode === "--om" || mode === "--om-stills";
const OM_MAX_FRAMES = 30 * 60 * 12; // 12 minutes
const nodePath = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
const readJson = (name) => JSON.parse(readFileSync(path.join(inDir, name), "utf8"));

let inputProps;
let meta;
if (tsx) {
  meta = readJson("meta.json");
  const n = meta.durationInFrames;
  if (!Number.isInteger(n) || n < 1 || n > 2700) throw new Error("meta.json: bad durationInFrames");
  if (!Array.isArray(meta.stills) || meta.stills.length > 8 || !meta.stills.every((f) => Number.isInteger(f) && f >= 0 && f < n)) throw new Error("meta.json: bad stills");
  const caps = meta.captions ?? []; // word times for the caption overlay (tsx-root draws them); written by the host
  if (!Array.isArray(caps) || caps.length > 1500 || !caps.every((w) => w && typeof w.word === "string" && w.word.length <= 60 && Number.isFinite(w.startS) && Number.isFinite(w.endS))) throw new Error("meta.json: bad captions");
  // The video's style id for the yt-kit look (tsx-root checks it against the known ids; unknown = ai_studio). Written by the host.
  const style = meta.style ?? "ai_studio";
  if (typeof style !== "string" || !/^[a-z_]{1,32}$/.test(style)) throw new Error("meta.json: bad style");
  inputProps = { props: readJson("props.json"), frames: n, captions: caps, style };
} else if (om) {
  meta = readJson("meta.json");
  if (meta.orientation !== "landscape" && meta.orientation !== "portrait") throw new Error("meta.json: bad orientation");
  if (!Array.isArray(meta.stills) || meta.stills.length > 8 || !meta.stills.every((f) => Number.isInteger(f) && f >= 0 && f < OM_MAX_FRAMES)) throw new Error("meta.json: bad stills");
  inputProps = readJson("props.json");
} else {
  inputProps = readJson("props.json");
}

// TSX only: "tsx-scene" (exactly) resolves to the checked file, and "yt-kit" (exactly) to our vetted drawing library
// (tsxlib/index.ts, trusted code from the read-only kit mount; the scene may import only the names checkTsx allows).
// Kit mode leaves resolve.alias untouched.
const withScene = (r) => {
  if (!tsx) return r;
  const scene = path.join(inDir, "video.tsx");
  const lib = path.join(import.meta.dirname, "tsxlib", "index.ts");
  // "yt-old/<lib>" (exactly) resolves to the old app's drawing library of that name (oldlib/, read-only kit mount). Only plain
  // top-level library files become aliases; the host's checkTsx has already allowed only the generated names.
  const oldDir = path.join(import.meta.dirname, "oldlib");
  const old = readdirSync(oldDir).filter((f) => /^[a-z][a-z0-9]*\.tsx?$/.test(f)).map((f) => ({ name: "yt-old/" + f.replace(/\.tsx?$/, ""), file: path.join(oldDir, f) }));
  const a = r.alias;
  return {
    ...r,
    alias: Array.isArray(a)
      ? [...a, { name: "tsx-scene", alias: scene, onlyModule: true }, { name: "yt-kit", alias: lib, onlyModule: true }, ...old.map((o) => ({ name: o.name, alias: o.file, onlyModule: true }))]
      : { ...(a ?? {}), "tsx-scene$": scene, "yt-kit$": lib, ...Object.fromEntries(old.map((o) => [`${o.name}$`, o.file])) },
  };
};
const serveUrl = await bundle({
  entryPoint: path.join(import.meta.dirname, tsx ? "tsx-index.ts" : om ? "om-index.ts" : "index.ts"),
  rootDir: "/opt/render",
  outDir: "/tmp/bundle", // the only writable places are /tmp (tmpfs) and the out dir
  publicDir: tsx || om ? path.join(inDir, "public") : inDir,
  enableCaching: false,
  webpackOverride: (c) => ({
    ...c,
    resolve: withScene({ ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] }),
    resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
  }),
});

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { gl: "swangle", disableWebSecurity: false, ignoreCertificateErrors: false };
let composition = await selectComposition({ serveUrl, id: mode === "--thumbnail" ? "thumbnail" : mode === "--landscape" ? "kit-video-landscape" : tsx ? "tsx-video" : om ? "Explainer" : "kit-video", inputProps, browserExecutable, chromiumOptions });
if (om) {
  if (composition.fps !== 30 || composition.durationInFrames < 1 || composition.durationInFrames > OM_MAX_FRAMES) throw new Error("the OpenMontage scene list is empty or longer than 12 minutes");
  if (!meta.stills.every((f) => f < composition.durationInFrames)) throw new Error("meta.json: a still is outside the video");
  if (meta.orientation === "portrait") composition = { ...composition, width: 1080, height: 1920 };
}
if (tsx && (composition.durationInFrames !== meta.durationInFrames || composition.fps !== 30 || composition.width !== 1080 || composition.height !== 1920)) {
  throw new Error("the TSX composition does not match meta.json");
}

if (mode === "--thumbnail") {
  // One still at the frame after the headline's pop-in. The composition must be the 1280x720 card the host asked for.
  if (composition.width !== 1280 || composition.height !== 720 || composition.fps !== 30 || composition.durationInFrames < 31) throw new Error("the thumbnail composition does not match 1280x720");
  await renderStill({ composition, serveUrl, frame: 30, output: outArg, imageFormat: "png", inputProps, browserExecutable, chromiumOptions, overwrite: true });
  console.log("PROGRESS 100");
} else if (mode === "--tsx-stills" || mode === "--om-stills") {
  for (const frame of meta.stills) {
    await renderStill({
      composition, serveUrl, frame, output: path.join(outArg, `still-${frame}.png`), imageFormat: "png", inputProps, browserExecutable,
      chromiumOptions, overwrite: true,
    });
    console.log(`PROGRESS ${Math.floor((100 * (meta.stills.indexOf(frame) + 1)) / meta.stills.length)}`);
  }
} else {
  let last = -1;
  // One chapter of a long render: a frame range of the whole composition, which must lie inside it.
  let frameRange;
  if (chunk) {
    const to = chunk.to === "end" ? composition.durationInFrames - 1 : chunk.to;
    if (chunk.from > to || to > composition.durationInFrames - 1) throw new Error(`--frames ${chunk.from}-${chunk.to} is outside the video (0-${composition.durationInFrames - 1})`);
    frameRange = [chunk.from, to];
  }
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outArg,
    inputProps,
    browserExecutable,
    chromiumOptions,
    overwrite: true,
    ...(frameRange ? { frameRange, muted: chunk.muted } : {}),
    onProgress: ({ progress }) => {
      const p = Math.floor(progress * 100);
      if (p !== last) {
        last = p;
        console.log(`PROGRESS ${p}`);
      }
    },
  });
  console.log("PROGRESS 100");
}
