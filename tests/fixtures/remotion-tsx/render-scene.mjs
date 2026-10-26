// render-scene.mjs <absolute jobDir>: bundle (compile) then render ONE still of the model-written scenes/Scene.tsx.
// Last stdout line is JSON: {"ok":true,...} or {"ok":false,"stage":"compile"|"render","error":"..."}.
// Note: webpack transpiles TSX without type checking, so type errors are not compile failures here.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { openBrowser, renderStill, selectComposition } = require("@remotion/renderer");

const jobDir = process.argv[2];
if (!jobDir || !path.isAbsolute(jobDir)) throw new Error("usage: render-scene.mjs <absolute jobDir>");
mkdirSync(path.join(jobDir, "out"), { recursive: true });
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { disableWebSecurity: false, gl: "swangle", ignoreCertificateErrors: false };
const nodePath = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);
const fail = (stage, e) => {
  console.log(JSON.stringify({ ok: false, stage, error: String(e && e.stack ? e.stack : e).slice(0, 4000) }));
  process.exit(1);
};

let serveUrl;
const t0 = performance.now();
try {
  serveUrl = await bundle({
    entryPoint: path.join(jobDir, "index.tsx"),
    rootDir: jobDir,
    outDir: path.join(jobDir, "bundle"),
    enableCaching: false,
    webpackOverride: (c) => ({
      ...c,
      resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] },
      resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
    }),
  });
} catch (e) {
  fail("compile", e);
}
const bundleMs = Math.round(performance.now() - t0);

const t1 = performance.now();
let browser;
try {
  browser = await openBrowser("chrome", { browserExecutable, chromiumOptions });
  const composition = await selectComposition({ serveUrl, id: "scene", puppeteerInstance: browser, browserExecutable, chromiumOptions });
  await renderStill({
    composition,
    serveUrl,
    output: path.join(jobDir, "out", "scene.png"),
    frame: 30,
    puppeteerInstance: browser,
    browserExecutable,
    chromiumOptions,
    overwrite: true,
    timeoutInMilliseconds: 30000,
  });
} catch (e) {
  await browser?.close({ silent: true }).catch(() => undefined);
  fail("render", e);
}
await browser.close({ silent: true });
console.log(JSON.stringify({ ok: true, bundleMs, renderMs: Math.round(performance.now() - t1) }));
