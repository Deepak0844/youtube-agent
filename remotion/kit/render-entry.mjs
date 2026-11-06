// Runs INSIDE the render container only (src/server/providers/renderer/remotion-container.ts starts it): node as a
// non-root user, --network none, read-only root, this kit mounted read-only at /opt/render/kit.
// usage: node /opt/render/kit/render-entry.mjs <inDir> <outFile>                 the scene kit (props.json)
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --scale3d       the 3D scale composition (props.json: scene, captions)
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outFile> --scale3d --native   the same on the host Mac's GPU (remotion-native.ts, inside sandbox-exec)
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outFile> --scene3d --native   the general 3D scene composition (props.json: scene; models/ staged in <inDir>), native ONLY
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outDir> --scene3d-stills --native   preview pictures of that scene: <inDir> also holds stills.json ({frames}); writes still-01.png ... at 540x960 into <outDir>; native ONLY
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outFile> --scene3d-code --native   an AI-written 3D scene: <inDir> holds scene.tsx (re-checked on the host), props.json and models/; native ONLY; guarded page (net-guard.mjs)
//        node <repo>/remotion/kit/render-entry.mjs <inDir> <outDir> --scene3d-code-stills --native   preview pictures of that scene (stills.json {frames}); also still-NN.hero.json per picture (where the scene's <Hero> sits); native ONLY
//        node /opt/render/kit/render-entry.mjs <inDir> <outFile> --tsx           one checked TSX file (video.tsx)
//        node /opt/render/kit/render-entry.mjs <inDir> <outDir> --tsx-stills     its preflight stills (still-<n>.png)
// Kit mode: <inDir> (read-only) holds props.json (built and validated on the host) plus the staged narration and asset
// files, served as the public dir. TSX modes: <inDir> holds video.tsx (statically checked and type-checked on the host),
// props.json, meta.json ({ durationInFrames, stills }) and public/ (the staged staticFile() files, the only public dir).
// The TSX bundle's entry is tsx-index.ts, which imports nothing of the kit; the scene and the yt-kit library are reached through webpack aliases.
// Prints "PROGRESS <0-100>" lines; the host turns them into stage log lines.
// ESM import ignores NODE_PATH; createRequire honours it (/opt/render/node_modules in the image).
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { authorWebpack } from "./author-bundle.mjs";
import { guardBrowser } from "./net-guard.mjs";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { renderMedia, renderStill, selectComposition } = require("@remotion/renderer");

const [inDir, outArg, mode = "kit", ...extraAll] = process.argv.slice(2);
// Authored-scene modes take `--expect-sha <sha256 of scene.tsx>` after --native: the file is hashed BEFORE bundling and any difference aborts.
const shaAt = extraAll.indexOf("--expect-sha");
const expectSha = shaAt >= 0 ? extraAll[shaAt + 1] : null;
const extra = shaAt >= 0 ? extraAll.slice(0, shaAt) : extraAll;
if (shaAt >= 0 && (shaAt !== extraAll.length - 2 || !/^[0-9a-f]{64}$/.test(expectSha ?? ""))) throw new Error("usage: --expect-sha <64 hex> must come last");
// "--native" (render on the host Mac's GPU, see remotion-native.ts) is accepted ONLY together with --scale3d or --scene3d. The container
// never passes it, so the container keeps software GL, its own paths and the default concurrency. Nothing else may follow the mode.
// "--scene3d" is native ONLY: it is refused without --native, so the container can never be asked to draw it.
const native = (mode === "--scale3d" || mode === "--scene3d" || mode === "--scene3d-stills" || mode === "--scene3d-code" || mode === "--scene3d-code-stills") && extra.length === 1 && extra[0] === "--native";
// "--scene3d-stills" is native ONLY too (it draws the same composition, a few frames of it).
if (!inDir || !outArg || !path.isAbsolute(inDir) || !path.isAbsolute(outArg) || (extra.length > 0 && !native) || ((mode === "--scene3d" || mode === "--scene3d-stills" || mode === "--scene3d-code" || mode === "--scene3d-code-stills") && !native) || !["kit", "--scale3d", "--scene3d", "--scene3d-stills", "--scene3d-code", "--scene3d-code-stills", "--tsx", "--tsx-stills"].includes(mode)) {
  throw new Error("usage: render-entry.mjs <abs inDir> <abs out> [--tsx | --tsx-stills]");
}
// Only the two TSX modes use meta.json, video.tsx and the TSX bundle. "--scale3d" and "--scene3d" are kit-style modes (props.json, the kit's index.ts, public dir = inDir) that renders another composition.
const tsx = mode === "--tsx" || mode === "--tsx-stills";
const scene3d = mode === "--scene3d" || mode === "--scene3d-stills";
// AI-written scene (untrusted code): its own bundle entry, one aliased file, an import allow-list enforced by the bundler, a guarded page.
const author = mode === "--scene3d-code" || mode === "--scene3d-code-stills";
const stillsMode = mode === "--scene3d-stills" || mode === "--scene3d-code-stills";
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
  if (author) {
    // Written and checked on the host; checked AGAIN here so a bad file never reaches the bundler. Only plain data: numbers, short strings, small lists.
    const p = inputProps;
    const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
    const okBeat = (b) => b && typeof b.id === "string" && b.id.length <= 40 && typeof b.text === "string" && b.text.length <= 400 && num(b.from, 0, 200) && num(b.to, 0, 200);
    const okCap = (c) => c && typeof c.text === "string" && c.text.length > 0 && c.text.length <= 40 && num(c.from, 0, 200) && num(c.to, 0, 200);
    const okModels = p.models && typeof p.models === "object" && !Array.isArray(p.models) && Object.keys(p.models).length <= 60
      && Object.entries(p.models).every(([k, v]) => /^[A-Za-z0-9_-]{1,80}$/.test(k) && typeof v === "string" && /^models\/[A-Za-z0-9_.-]{1,100}\.glb$/.test(v));
    if (!Number.isInteger(p.frames) || p.frames < 1 || p.frames > 2250 || !num(p.durationS, 0.1, 75) || Math.abs(p.frames - p.durationS * 30) > 1.01 || !Array.isArray(p.beats) || p.beats.length < 1 || p.beats.length > 30 || !p.beats.every(okBeat)
      || !Array.isArray(p.captions) || p.captions.length > 30 || !p.captions.every(okCap) || !okModels || Object.keys(p).sort().join() !== "beats,captions,durationS,frames,models") throw new Error("props.json: bad scene props");
  }
}

// AI-written scene, preview pictures only: ask every <Hero> to report where it sits in the frame (console lines the page prints, read below).
// Set AFTER props.json was validated; the render itself never gets this flag.
if (mode === "--scene3d-code-stills") inputProps = { ...inputProps, probeHero: true };

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
// AI-written scene only: the webpack side (exact aliases, parser switches, fail-closed import allow-list) lives in author-bundle.mjs so a unit test can bundle hostile scenes with it.
if (author) {
  const sceneBytes = readFileSync(path.join(inDir, "scene.tsx"));
  if (!expectSha || createHash("sha256").update(sceneBytes).digest("hex") !== expectSha) throw new Error("scene.tsx is not the approved file (sha256 differs or --expect-sha is missing)");
}
const bundled = await bundle({
  entryPoint: path.join(import.meta.dirname, tsx ? "tsx-index.ts" : author ? "s3k-author-index.tsx" : "index.ts"),
  rootDir: native ? path.resolve(import.meta.dirname, "..", "..") : "/opt/render",
  // the only writable places are /tmp (tmpfs) and the out dir; native: the private TMPDIR the host sandbox allows
  outDir: native ? path.join(tmpdir(), `bundle-${process.pid}`) : "/tmp/bundle",
  publicDir: tsx ? path.join(inDir, "public") : inDir,
  enableCaching: false,
  webpackOverride: (c) => {
    const base = {
      ...c,
      resolve: withScene({ ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] }),
      resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
    };
    return author ? authorWebpack(base, { inDir, kitDir: import.meta.dirname, repoRoot: path.resolve(import.meta.dirname, "..", "..") }) : base;
  },
});

// AI-written scene: WE serve the bundle on 127.0.0.1 (a plain read-only static server, contained to the bundle folder), so the page guard gets the
// EXACT origin as a parameter instead of learning it from traffic.
let staticServer;
let serveUrl = bundled;
let browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
if (author) {
  const root = realpathSync(bundled);
  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".glb": "model/gltf-binary", ".ico": "image/x-icon" };
  staticServer = createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const rel = decodeURIComponent(u.pathname === "/" ? "/index.html" : u.pathname);
      const file = realpathSync(path.join(root, rel));
      if (!(file === root || file.startsWith(root + path.sep)) || !statSync(file).isFile() || req.method !== "GET") throw new Error("no");
      res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Content-Length": statSync(file).size });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => staticServer.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${staticServer.address().port}`;
  serveUrl = origin;
  globalThis.__s3kOrigin = origin;
  // Chrome gets one extra flag through a tiny wrapper (Remotion offers no args option): no WebRTC UDP at all (ICE/STUN to loopback or the LAN).
  if (browserExecutable && typeof process.execve === "function" && !/["\\\n]/.test(browserExecutable)) {
    const wrapper = path.join(tmpdir(), "chrome-guard.js");
    writeFileSync(wrapper, `#!${process.execPath}\nconst real = ${JSON.stringify(browserExecutable)};\nprocess.execve(real, [real, ...process.argv.slice(2), "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"], process.env);\n`, { mode: 0o700 });
    chmodSync(wrapper, 0o700);
    browserExecutable = wrapper;
  } else console.log("GUARD note: process.execve is unavailable, so the Chrome WebRTC UDP flag is not set (the checker, CSP and page script still block WebRTC)");
}
const chromiumOptions = { gl: native ? "angle" : "swangle", disableWebSecurity: false, ignoreCertificateErrors: false };
// AI-written scene: ONE browser we open ourselves, so every page it opens is guarded (CSP + request filter, net-guard.mjs) before it loads anything.
let guarded;
if (author) {
  const { openBrowser } = require("@remotion/renderer");
  guarded = await openBrowser("chrome", { browserExecutable, chromiumOptions });
  guardBrowser(guarded, { origin: globalThis.__s3kOrigin, log: (line) => console.log(line), onViolation: () => { console.log("GUARD violation: the page opened something it may not; the render is stopped"); process.exit(3); } });
}
try {
const composition = await selectComposition({ serveUrl, id: author ? "s3k-author" : tsx ? "tsx-video" : scene3d ? "scene3d" : mode === "--scale3d" ? "scale3d" : "kit-video", inputProps, browserExecutable, chromiumOptions, ...(guarded ? { puppeteerInstance: guarded } : {}) });
if (author && (composition.durationInFrames !== inputProps.frames || composition.fps !== 30 || composition.width !== 1080 || composition.height !== 1920)) throw new Error("the scene composition does not match props.json");
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
} else if (stillsMode) {
  // The frames come from the host (stills.json); each must lie inside the composition. Half size: 540x960. Names are by position, never by frame.
  const frames = readJson("stills.json").frames;
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 8 || !frames.every((f) => Number.isInteger(f) && f >= 0 && f < composition.durationInFrames)) throw new Error("stills.json: bad frames");
  // Hero reports (AI-written scenes only): the last "S3K_HERO {frame,width,height,clipped}" line per frame. The page is untrusted, so the numbers are
  // re-checked here and again on the host; the file is advice for the owner, never a permission.
  const heroLog = new Map();
  const onBrowserLog = (l) => {
    const m = author && typeof l?.text === "string" ? /^S3K_HERO (\{[^\n]{0,200}\})$/.exec(l.text) : null;
    if (!m) return;
    try {
      const o = JSON.parse(m[1]);
      if (Number.isInteger(o.frame) && Number.isFinite(o.width) && Number.isFinite(o.height) && typeof o.clipped === "boolean") heroLog.set(o.frame, { width: o.width, height: o.height, clipped: o.clipped });
    } catch { /* not ours */ }
  };
  for (const [i, frame] of frames.entries()) {
    const name = String(i + 1).padStart(2, "0");
    heroLog.clear();
    await renderStill({
      composition, serveUrl, frame, output: path.join(outArg, `still-${name}.png`), imageFormat: "png", inputProps, browserExecutable,
      chromiumOptions, scale: 0.5, overwrite: true, onBrowserLog, ...(guarded ? { puppeteerInstance: guarded } : {}),
    });
    if (author) writeFileSync(path.join(outArg, `still-${name}.hero.json`), JSON.stringify(heroLog.has(frame) ? { declared: true, ...heroLog.get(frame) } : { declared: false }), { mode: 0o600 });
    console.log(`PROGRESS ${Math.floor((100 * (i + 1)) / frames.length)}`);
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
    ...(guarded ? { puppeteerInstance: guarded } : {}),
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
} finally {
  // Always close our own browser and server (Remotion only closes browsers it opened itself); its connection can keep the process alive otherwise.
  if (guarded) await Promise.race([guarded.close().catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
  staticServer?.close();
}
if (guarded) process.exit(0);
