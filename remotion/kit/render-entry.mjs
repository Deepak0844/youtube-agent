// Runs INSIDE the render container only (src/server/providers/renderer/remotion-container.ts starts it): node as a
// non-root user, --network none, read-only root, this kit mounted read-only at /opt/render/kit.
// usage: node /opt/render/kit/render-entry.mjs <inDir> <outFile>                 the scene kit (props.json)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --scale3d       the 3D scale composition (props.json: scene, captions)
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outFile> --scale3d --native   the same on the host Mac's GPU (remotion-native.ts, inside sandbox-exec)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --tsx           one checked TSX file (video.tsx)
//        node /opt/render/kit/render-entry.mjs <inDir> <outDir> --tsx-stills     its preflight stills (still-<n>.png)
// Kit mode: <inDir> (read-only) holds props.json (built and validated on the host) plus the staged narration and asset
// files, served as the public dir. TSX modes: <inDir> holds video.tsx (statically checked and type-checked on the host),
// props.json, meta.json ({ durationInFrames, stills }) and public/ (the staged staticFile() files, the only public dir).
// The TSX bundle's entry is tsx-index.ts, which imports nothing of the kit; the scene and the yt-kit library are reached through webpack aliases.
// Prints "PROGRESS <0-100>" lines; the host turns them into stage log lines.
// ESM import ignores NODE_PATH; createRequire honours it (/opt/render/node_modules in the image).
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = require("@remotion/renderer");

const [inDir, outArg, mode = "kit", ...extra] = process.argv.slice(2);
// "--native" (render on the host Mac's GPU, see remotion-native.ts) is accepted ONLY together with --scale3d. The container
// never passes it, so the container keeps software GL, its own paths and the default concurrency. Nothing else may follow the mode.
const native = mode === "--scale3d" && extra.length === 1 && extra[0] === "--native";
if (!inDir || !outArg || !path.isAbsolute(inDir) || !path.isAbsolute(outArg) || (extra.length > 0 && !native) || !["kit", "--scale3d", "--tsx", "--tsx-stills"].includes(mode)) {
  throw new Error("usage: render-entry.mjs <abs inDir> <abs out> [--tsx | --tsx-stills]");
}
// Only the two TSX modes use meta.json, video.tsx and the TSX bundle. "--scale3d" is a kit-style mode (props.json, the kit's index.ts, public dir = inDir) that renders another composition.
const tsx = mode === "--tsx" || mode === "--tsx-stills";
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
  const a = r.alias;
  return {
    ...r,
    alias: Array.isArray(a)
      ? [...a, { name: "tsx-scene", alias: scene, onlyModule: true }, { name: "yt-kit", alias: lib, onlyModule: true }]
      : { ...(a ?? {}), "tsx-scene$": scene, "yt-kit$": lib },
  };
};
const serveUrl = await bundle({
  entryPoint: path.join(import.meta.dirname, tsx ? "tsx-index.ts" : "index.ts"),
  rootDir: native ? path.resolve(import.meta.dirname, "..", "..") : "/opt/render",
  // the only writable places are /tmp (tmpfs) and the out dir; native: the private TMPDIR the host sandbox allows
  outDir: native ? path.join(tmpdir(), `bundle-${process.pid}`) : "/tmp/bundle",
  publicDir: tsx ? path.join(inDir, "public") : inDir,
  enableCaching: false,
  webpackOverride: (c) => ({
    ...c,
    resolve: withScene({ ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] }),
    resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
  }),
});

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { gl: native ? "angle" : "swangle", disableWebSecurity: false, ignoreCertificateErrors: false };
const composition = await selectComposition({ serveUrl, id: tsx ? "tsx-video" : mode === "--scale3d" ? "scale3d" : "kit-video", inputProps, browserExecutable, chromiumOptions });
if (tsx && (composition.durationInFrames !== meta.durationInFrames || composition.fps !== 30 || composition.width !== 1080 || composition.height !== 1920)) {
  throw new Error("the TSX composition does not match meta.json");
}

if (mode === "--tsx-stills") {
  for (const frame of meta.stills) {
    await renderStill({
      composition, serveUrl, frame, output: path.join(outArg, `still-${frame}.png`), imageFormat: "png", inputProps, browserExecutable,
      chromiumOptions, overwrite: true,
    });
    console.log(`PROGRESS ${Math.floor((100 * (meta.stills.indexOf(frame) + 1)) / meta.stills.length)}`);
  }
} else {
  let last = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: outArg,
    inputProps,
    browserExecutable,
    chromiumOptions,
    overwrite: true,
    ...(native ? { concurrency: 1 } : {}),
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
