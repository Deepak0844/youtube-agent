// Spike (Phase 0, Task 7): runs INSIDE the render container. Renders shorts from a COPY of the old project's
// remotion/src (copied into <jobDir>/src by the test) with ONE bundle and ONE browser reused across all ids.
//   node render-old-shorts.mjs <jobDir> <publicDir> <compositionId>...
// Last stdout line: {"result":{bundleMs,browserMs,findings,shorts:[{name,frames,wallMs,renderMs,peakRssMb,cpuSeconds,findings}]}}
// ESM import ignores NODE_PATH; createRequire's require honours it (/opt/render/node_modules in the image).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { openBrowser, renderMedia, selectComposition } = require("@remotion/renderer");

const tStart = performance.now();
const [jobDir, publicDir, ...ids] = process.argv.slice(2);
if (!jobDir || !path.isAbsolute(jobDir) || !publicDir || !path.isAbsolute(publicDir) || ids.length === 0) {
  throw new Error("usage: render-old-shorts.mjs <absolute jobDir> <absolute publicDir> <compositionId>...");
}
const src = path.join(jobDir, "src");
const out = path.join(jobDir, "out");
mkdirSync(out, { recursive: true });
const findings = [];

// WORKAROUND (pre-approved, copy only): fonts.ts loads its five brand families via @remotion/google-fonts,
// which fetches from fonts.gstatic.com at render time (fails under --network none). Same exports, same
// families, now resolved from the fonts baked into the image (infra/render/fonts).
const oldFonts = readFileSync(path.join(src, "fonts.ts"), "utf8");
if (oldFonts.includes("@remotion/google-fonts")) {
  const indic = /const INDIC_FALLBACK = (.*);/.exec(oldFonts)?.[1];
  if (!indic) throw new Error("fonts.ts: INDIC_FALLBACK not found; fonts loader replacement needs review");
  writeFileSync(
    path.join(src, "fonts.ts"),
    [
      "// WORKAROUND (spike copy): system-installed vendored fonts instead of @remotion/google-fonts (needs network).",
      `const INDIC_FALLBACK = ${indic};`,
      'export const FONT_DISPLAY = `"Space Grotesk", ${INDIC_FALLBACK}`;',
      'export const FONT_BODY = `"Inter", ${INDIC_FALLBACK}`;',
      'export const FONT_MONO = \'"JetBrains Mono"\';',
      'export const FONT_SERIF = \'"Spectral"\';',
      'export const FONT_EDITORIAL = \'"Source Serif 4"\';',
      "",
    ].join("\n"),
  );
  findings.push(
    "WORKAROUND(pre-approved) src/fonts.ts:2-6 imports @remotion/google-fonts (SpaceGrotesk, Inter, JetBrainsMono, Spectral, SourceSerif4): network fetch at render time; replaced in the copy with the image's vendored families",
  );
}

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { disableWebSecurity: false, gl: "swangle", ignoreCertificateErrors: false };
const nodePath = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
// The container is capped at 4 CPUs (runner DEFAULT_LIMITS) but os.cpus() reports the VM's count.
const concurrency = Number(process.env.RENDER_CONCURRENCY ?? 4);

const cg = (f) => {
  try {
    return readFileSync(path.join("/sys/fs/cgroup", f), "utf8");
  } catch {
    return null;
  }
};
const cpuUsec = () => Number(/usage_usec (\d+)/.exec(cg("cpu.stat") ?? "")?.[1] ?? NaN);
const peakMb = () => {
  const v = cg("memory.peak");
  return v == null ? process.resourceUsage().maxRSS / 1024 : Number(v.trim()) / 1024 / 1024;
};

const t0 = performance.now();
const serveUrl = await bundle({
  entryPoint: path.join(src, "index.ts"),
  rootDir: jobDir, // root fs is read-only
  outDir: path.join(jobDir, "bundle"),
  // remotion.config.ts's Config.setPublicDir('../media') is CLI-only; the programmatic API needs it explicitly.
  publicDir,
  enableCaching: false,
  // webpack does not read NODE_PATH: resolve remotion/react/kit packages from the image.
  webpackOverride: (c) => ({
    ...c,
    resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] },
    resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
  }),
});
const bundleMs = performance.now() - t0;

const t1 = performance.now();
const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions });
const browserMs = performance.now() - t1;

const shorts = [];
for (const id of ids) {
  const own = [];
  const onBrowserLog = ({ type, text }) => {
    if (type === "error" || type === "warning") own.push(`browser ${type}: ${text.slice(0, 300)}`);
  };
  const cpu0 = cpuUsec();
  const t = performance.now();
  const composition = await selectComposition({ serveUrl, id, puppeteerInstance: browser, browserExecutable, chromiumOptions, onBrowserLog });
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    imageFormat: "jpeg",
    crf: 18,
    concurrency,
    outputLocation: path.join(out, `${id}.mp4`),
    puppeteerInstance: browser,
    browserExecutable,
    chromiumOptions,
    onBrowserLog,
    overwrite: true,
  });
  const renderMs = performance.now() - t;
  shorts.push({
    name: id,
    frames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    // first short in a job carries the bundle + browser start; later ones only their own render
    wallMs: Math.round(shorts.length === 0 ? performance.now() - tStart : renderMs),
    renderMs: Math.round(renderMs),
    peakRssMb: Math.round(peakMb()), // cgroup memory.peak: whole container incl. Chrome, cumulative per job
    cpuSeconds: Math.round((cpuUsec() - cpu0) / 1e4) / 100,
    findings: [...new Set(own)],
  });
  console.log(`rendered ${id}: ${composition.durationInFrames} frames in ${Math.round(renderMs)} ms`);
}
await browser.close({ silent: true });

console.log(JSON.stringify({ result: { bundleMs: Math.round(bundleMs), browserMs: Math.round(browserMs), concurrency, findings, shorts } }));
