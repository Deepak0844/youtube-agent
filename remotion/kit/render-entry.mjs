// Runs INSIDE the render container only (src/server/providers/renderer/remotion-container.ts starts it): node as a
// non-root user, --network none, read-only root, this kit mounted read-only at /opt/render/kit.
// usage: node /opt/render/kit/render-entry.mjs <inDir> <outFile>
// <inDir> (read-only) holds props.json (built and validated on the host) plus the staged narration and asset files,
// served as the public dir. Prints "PROGRESS <0-100>" lines; the host turns them into stage log lines.
// ESM import ignores NODE_PATH; createRequire honours it (/opt/render/node_modules in the image).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { bundle } = require("@remotion/bundler");
const { renderMedia, selectComposition } = require("@remotion/renderer");

const [inDir, outFile] = process.argv.slice(2);
if (!inDir || !outFile || !path.isAbsolute(inDir) || !path.isAbsolute(outFile)) throw new Error("usage: render-entry.mjs <abs inDir> <abs outFile>");
const inputProps = JSON.parse(readFileSync(path.join(inDir, "props.json"), "utf8"));
const nodePath = (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean);

const serveUrl = await bundle({
  entryPoint: path.join(import.meta.dirname, "index.ts"),
  rootDir: "/opt/render",
  outDir: "/tmp/bundle", // the only writable places are /tmp (tmpfs) and the out dir
  publicDir: inDir,
  enableCaching: false,
  webpackOverride: (c) => ({
    ...c,
    resolve: { ...c.resolve, modules: [...(c.resolve?.modules ?? ["node_modules"]), ...nodePath] },
    resolveLoader: { ...c.resolveLoader, modules: [...(c.resolveLoader?.modules ?? ["node_modules"]), ...nodePath] },
  }),
});

const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE;
const chromiumOptions = { gl: "swangle", disableWebSecurity: false, ignoreCertificateErrors: false };
const composition = await selectComposition({ serveUrl, id: "kit-video", inputProps, browserExecutable, chromiumOptions });
let last = -1;
await renderMedia({
  composition,
  serveUrl,
  codec: "h264",
  outputLocation: outFile,
  inputProps,
  browserExecutable,
  chromiumOptions,
  overwrite: true,
  onProgress: ({ progress }) => {
    const p = Math.floor(progress * 100);
    if (p !== last) {
      last = p;
      console.log(`PROGRESS ${p}`);
    }
  },
});
console.log("PROGRESS 100");
