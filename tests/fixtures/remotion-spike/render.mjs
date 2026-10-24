// render.mjs <jobDir> [--still-only]
// Bundles the fixture, opens ONE browser, renders a cold still, the video, then a warm still with the same
// browser. Last stdout line: {"coldMs","warmMs","peakRssMb","peakRssSource",...}.
// ESM import ignores NODE_PATH; createRequire's require honours it (/opt/render/node_modules in the image).
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { openBrowser, renderMedia, renderStill, selectComposition } = require("@remotion/renderer");

const jobDir = process.argv[2];
const stillOnly = process.argv.includes("--still-only");
if (!jobDir || !path.isAbsolute(jobDir)) throw new Error("usage: render.mjs <absolute jobDir> [--still-only]");
const out = path.join(jobDir, "out");
mkdirSync(out, { recursive: true });

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { disableWebSecurity: false, gl: "swangle", ignoreCertificateErrors: false };
const nodePath = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);

const t0 = performance.now();
const serveUrl = await bundle({
  entryPoint: path.join(jobDir, "index.tsx"),
  rootDir: jobDir, // root fs is read-only; /job is not writable
  outDir: path.join(jobDir, "bundle"),
  publicDir: path.join(jobDir, "public"),
  enableCaching: false,
  // webpack does not read NODE_PATH: let the fixture resolve remotion/react from the image.
  webpackOverride: (c) => ({
    ...c,
    resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] },
    resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
  }),
});
const bundleMs = performance.now() - t0;

const t1 = performance.now();
const browser = await openBrowser("chrome", { browserExecutable, chromiumOptions });
const composition = await selectComposition({ serveUrl, id: "indic", puppeteerInstance: browser, browserExecutable, chromiumOptions });
const still = (output) =>
  renderStill({ composition, serveUrl, output, frame: 30, puppeteerInstance: browser, browserExecutable, chromiumOptions, overwrite: true });
await still(path.join(out, "indic.png"));
const coldMs = performance.now() - t1;

let videoMs = null;
if (!stillOnly) {
  const t2 = performance.now();
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: path.join(out, "indic.mp4"),
    puppeteerInstance: browser,
    browserExecutable,
    chromiumOptions,
    overwrite: true,
  });
  videoMs = performance.now() - t2;
}

const t3 = performance.now();
await still(path.join(out, "indic-warm.png"));
const warmMs = performance.now() - t3;
await browser.close({ silent: true });

let peakRssMb;
let peakRssSource;
try {
  peakRssMb = Number(readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim()) / 1024 / 1024;
  peakRssSource = "cgroup memory.peak (whole container incl. Chrome)";
} catch {
  peakRssMb = process.resourceUsage().maxRSS / 1024;
  peakRssSource = "process.resourceUsage().maxRSS (node only)";
}
const r = (n) => (n == null ? n : Math.round(n));
console.log(JSON.stringify({ coldMs: r(coldMs), warmMs: r(warmMs), peakRssMb: r(peakRssMb), peakRssSource, bundleMs: r(bundleMs), videoMs: r(videoMs) }));
