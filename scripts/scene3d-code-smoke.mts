// Real native smoke of an AI-written 3D scene: the production renderer (stageSceneCode + the macOS sandbox + the guarded page), one still.
//   nice -n 19 npx tsx scripts/scene3d-code-smoke.mts <scene.tsx> [--frames 30,200] [--out <dir>] [--files <assets3d/files dir>]
//   nice -n 19 npx tsx scripts/scene3d-code-smoke.mts --probe [--out <dir>]
// First form: checks the file (the same checker as the app), then draws the frames. A file the checker rejects stops BEFORE any render.
// --probe: the network-defence check. A HOSTILE scene (it tries Image, fetch, XMLHttpRequest, WebSocket, sendBeacon, script and iframe elements
// against a loopback listener on another port) is staged by hand, bypassing the checker ON PURPOSE (a test-only harness), and drawn in the
// same sandbox command. It passes when the listener saw NO connection and the page printed `GUARD blocked` lines for that port.
// One render at a time. Not part of any CI job: it needs this Mac's Chrome shell (npx remotion browser ensure).
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEngineConfig } from "../src/server/core/engine-config";
import { checkScene3dCode } from "../src/server/core/scene3d-code-check";
import { sceneProps } from "../src/server/core/scene3d-author-prompt";
import { sceneCodeSha } from "../src/server/core/scene3d-code-body";
import { runChild } from "../src/server/render/child";
import { nativeCommand } from "../src/server/providers/renderer/native-sandbox";
import { checkNativeRenderReady } from "../src/server/providers/renderer/native-preflight";
import { createNativeRenderer } from "../src/server/providers/renderer/remotion-native";
import { loadRepoCatalog } from "../src/server/providers/renderer/scene3d-models";
import type { StageContext } from "../src/server/core/stage-handler";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const probe = args.includes("--probe");
const storage = await realpath(mkdtempSync(path.join(os.tmpdir(), "s3k-smoke-")));
const attemptDir = path.join(storage, "videos", "v1", "attempt-smoke");
mkdirSync(attemptDir, { recursive: true });
const out = path.resolve(opt("out") ?? path.join(os.tmpdir(), "s3k-code-smoke"));
mkdirSync(out, { recursive: true });

const BEATS = [
  { id: "hook", line: "A crane lifts a container onto a ship.", visual: "crane lifts", from: 0, to: 6 },
  { id: "setup", line: "Then the ship sails away.", visual: "ship sails", from: 6, to: 12 },
];
const props = sceneProps(BEATS, 12);
const log = (l: string) => console.log(`  ${l}`);
const ctx = {
  stage: { name: "scene3d_stills", videoId: "v1" }, claim: { stageRunId: "smoke-1", fence: 1 }, config: buildEngineConfig(new Map<string, unknown>([["render.native_3d", true]])), signal: new AbortController().signal, attemptDir, log, progress: () => undefined,
  nextStep: () => 0, paid: async () => { throw new Error("no paid calls"); },
} as unknown as StageContext;
const ready = await checkNativeRenderReady({ repoRoot: root });
if (!ready.ready || ready.chromeDir === null) throw new Error(`native render not ready: ${ready.message}`);

if (!probe) {
  const file = args.find((a) => !a.startsWith("--") && a !== opt("frames") && a !== opt("out") && a !== opt("files"));
  if (!file) throw new Error("usage: scene3d-code-smoke.mts <scene.tsx> | --probe");
  const source = readFileSync(path.resolve(file), "utf8");
  const checked = checkScene3dCode(source);
  console.log(`checker: ${checked.ok ? "PASS" : `REJECT (${checked.problems.length}): ${checked.problems.slice(0, 3).join(" | ")}`}`);
  if (!checked.ok) { console.log("stopped BEFORE any render"); process.exit(2); }
  const frames = (opt("frames") ?? "30,150,300").split(",").map(Number);
  const renderer = createNativeRenderer({
    root: storage, kitDir: path.join(root, "remotion", "kit"), runChild: (spec) => runChild(spec), probe: async () => { throw new Error("no probe"); }, preflight: async () => ready,
    catalog: () => loadRepoCatalog(root), assetsDir: opt("files") ?? path.join(root, "assets3d", "files"),
  });
  const t0 = Date.now();
  const r = await renderer.stills(ctx, { scene3dCode: { source, props, expectedSha256: sceneCodeSha(source, props) }, frames });
  for (const f of r.files) { const to = path.join(out, `${path.basename(f)}`); writeFileSync(to, readFileSync(path.join(attemptDir, f))); console.log(`png ${to} (${readFileSync(to).length} bytes)`); }
  console.log(`rendered ${r.files.length} still(s) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} else {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.end("hit"); });
  server.on("upgrade", (req, socket) => { hits.push(`UPGRADE ${req.url}`); socket.destroy(); });
  server.on("connection", () => hits.push("CONNECTION"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const hostile = `import { World, CameraRig, Finish } from "s3k";
const PORT = ${port};
const g = globalThis as unknown as Record<string, any>;
function attack() {
  const url = (p: string) => "http://127.0.0.1:" + PORT + "/" + p;
  const say = (name: string, what: string) => console.error("PROBE " + name + " " + what);
  const tries: [string, () => void][] = [
    ["image", () => { const i = new g.Image(); i.onload = () => say("image", "ALLOWED"); i.onerror = () => say("image", "blocked"); i.src = url("image"); }],
    ["fetch", () => { g.fetch(url("fetch")).then(() => say("fetch", "ALLOWED")).catch(() => say("fetch", "blocked")); }],
    ["xhr", () => { const x = new g.XMLHttpRequest(); x.onload = () => say("xhr", "ALLOWED"); x.onerror = () => say("xhr", "blocked"); x.open("GET", url("xhr")); x.send(); }],
    ["websocket", () => { const w = new g.WebSocket("ws://127.0.0.1:" + PORT + "/ws"); w.onopen = () => say("websocket", "ALLOWED"); w.onerror = () => say("websocket", "blocked"); }],
    ["beacon", () => { say("beacon", g.navigator.sendBeacon(url("beacon"), "x") ? "queued-by-browser(the listener below is the proof)" : "blocked"); }],
    ["script", () => { const s = g.document.createElement("script"); s.onload = () => say("script", "ALLOWED"); s.onerror = () => say("script", "blocked"); s.src = url("script.js"); g.document.head.appendChild(s); }],
    ["iframe", () => { const f = g.document.createElement("iframe"); f.onload = () => say("iframe", "loaded-or-error-page"); f.src = url("frame"); g.document.body.appendChild(f); }],
    ["eval", () => { say("eval", g.eval("1+1") === 2 ? "ALLOWED" : "blocked"); }],
    ["worker", () => { new g.Worker(url("worker.js")); say("worker", "CREATED-UNEXPECTED-ALLOWED"); }],
  ];
  for (const [name, t] of tries) { try { t(); } catch { say(name, "blocked(exception)"); } }
}
attack();
export default function Scene() {
  attack();
  return <World focus={{ min: [0, 0, 0], max: [1, 1, 1] }} />;
}
`;
  console.log(`probe: loopback listener on 127.0.0.1:${port}; staging a hostile scene by hand (checker bypassed on purpose)`);
  const inDir = path.join(attemptDir, "native-in"), outDir = path.join(attemptDir, "native-out"), tmpDir = path.join(attemptDir, "native-tmp");
  await Promise.all([inDir, outDir, tmpDir].map((d) => mkdir(d, { recursive: true, mode: 0o700 })));
  writeFileSync(path.join(inDir, "scene.tsx"), hostile);
  writeFileSync(path.join(inDir, "props.json"), JSON.stringify({ beats: props.beats, captions: props.captions, durationS: props.durationS, frames: Math.round(props.durationS * 30), models: {} }));
  writeFileSync(path.join(inDir, "stills.json"), JSON.stringify({ frames: [10] }));
  const nodeReal = await realpath(process.execPath);
  const cmd = nativeCommand({
    repoRoot: root, kitDir: path.join(root, "remotion", "kit"), nodeModules: await realpath(path.join(root, "node_modules")), storageRoot: storage, homeDir: await realpath(os.homedir()),
    inDir, outDir, tmpDir, nodePrefix: path.dirname(path.dirname(nodeReal)), chromeDir: ready.chromeDir, node: nodeReal, outFile: outDir, mode: "--scene3d-code-stills",
  });
  const lines: string[] = [];
  const r = await runChild({ ...cmd, cwd: tmpDir, cwdRoot: attemptDir, envAllow: [], timeoutMs: 240_000, maxOutputBytes: 1024 * 1024, signal: ctx.signal, stageRunId: "smoke-probe", onLine: (l: string) => { lines.push(l); if (/GUARD|PROBE/.test(l)) console.log(`  child: ${l.slice(0, 200)}`); } });
  server.close();
  const blocked = lines.filter((l) => l.startsWith("GUARD blocked") && l.includes(`:${port}`));
  const allowed = lines.filter((l) => /PROBE \w+ ALLOWED/.test(l));
  console.log(`child exit code ${r.code}; listener hits: ${hits.length} ${JSON.stringify(hits)}; GUARD blocked lines for the listener port: ${blocked.length}; PROBE lines saying ALLOWED: ${allowed.length}`);
  await rm(storage, { recursive: true, force: true });
  if (hits.length > 0 || allowed.length > 0) { console.log("PROBE FAILED: the hostile scene reached the listener or an attempt was allowed"); process.exit(1); }
  console.log(lines.some((l) => /PROBE \w+ blocked/.test(l)) ? "PROBE PASSED: every attempt was stopped, none reached the listener" : "PROBE INCONCLUSIVE: no hits, but the page reported no attempts");
}
