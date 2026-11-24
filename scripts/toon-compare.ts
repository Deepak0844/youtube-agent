// Exact-match proof for the cartoon kit (dev only; not in CI, no render in CI). Draws a frame every 0.5 s of an upstream cartoon-shorts episode
// with cartoon-shorts' own renderer (headless Chrome) and the same frames of the yt-toon port (Remotion, same chromium settings as the app's
// render), then prints the pixel difference. Writes .data/compare/toon/<name>/sheet.png (upstream | port per frame).
//   npx tsx scripts/toon-compare.ts <upstreamEpisodeDir> <exampleDir> [--until <s>] [--from <s>] [--step <s>]
// <upstreamEpisodeDir> holds short.html, scenes.js, timeline.js (an episode made with cartoon-shorts); <exampleDir> holds video.tsx and
// toon.json (the beats and scenes from timeline.js; written here when missing). Exit 1 when a frame's mean difference is over 2/255 (mean of
// frames) or any frame is over 4/255. A failing frame is fixed in the kit, never by changing these numbers.
// Fonts: the vendored OFL fonts are loaded as @font-face from a temporary public folder (the app's render image has them installed).
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const MEAN_MAX = 2;
const WORST_MAX = 4;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n: string, d: number) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const [epDir, exDir] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")).map((p) => path.resolve(p.replace(/^~/, os.homedir())));
if (!epDir || !exDir) throw new Error("usage: toon-compare.ts <upstreamEpisodeDir> <exampleDir> [--from s] [--until s] [--step s]");
const name = path.basename(exDir);
const out = path.join(root, ".data/compare/toon", name);
const STEP = flag("--step", 0.5);
const FROM = flag("--from", 0);

type Timeline = { total: number; scenes: { id: string; start: number; end: number }[]; lines: { t: number; d: number; cap: string | null }[] };
const timeline = (): Timeline => {
  const src = readFileSync(path.join(epDir, "timeline.js"), "utf8");
  return JSON.parse(src.replace(/^\s*window\.TIMELINE\s*=\s*/, "").replace(/;\s*$/, "")) as Timeline;
};
const TL = timeline();
const UNTIL = Math.min(flag("--until", TL.total), TL.total);

function toonJson() {
  const f = path.join(exDir, "toon.json");
  if (!existsSync(f)) {
    const toon = {
      timeline: { beats: TL.lines.map((l) => ({ startS: l.t, endS: l.t + l.d, cap: l.cap })), scenes: TL.scenes.map((s) => ({ id: s.id, startS: s.start, endS: s.end })) },
      cast: [],
      orientation: "portrait",
    };
    writeFileSync(f, JSON.stringify(toon, null, 1));
  }
  return JSON.parse(readFileSync(f, "utf8")) as { timeline: unknown; cast: unknown[]; orientation: string };
}

const times: number[] = [];
for (let t = FROM; t < UNTIL - 1e-6; t += STEP) times.push(Math.round(t * 1000) / 1000);

async function upstream(tmp: string): Promise<string[]> {
  // the episode page loads ../../engine/...: rebuild that layout in a temp folder so the owner's own stills are never touched
  const series = path.dirname(path.dirname(epDir));
  const hasEngine = existsSync(path.join(series, "engine/render.mjs"));
  const engine = hasEngine ? path.join(series, "engine") : path.join(path.dirname(path.dirname(epDir)), "engine");
  const base = path.join(tmp, "up");
  mkdirSync(path.join(base, "episodes"), { recursive: true });
  symlinkSync(engine, path.join(base, "engine"));
  const ep = path.join(base, "episodes", name);
  cpSync(epDir, ep, { recursive: true, filter: (s) => !/[\\/](out|stills|audio|rec|research)([\\/]|$)/.test(s) });
  execFileSync("node", [path.join(base, "engine/render.mjs"), ep, "still", ...times.map(String)], { stdio: ["ignore", "inherit", "inherit"] });
  return times.map((t) => path.join(ep, "stills", `t${t}.png`));
}

async function ours(tmp: string): Promise<string[]> {
  const { bundle } = await import("@remotion/bundler");
  const { renderStill, selectComposition } = await import("@remotion/renderer");
  const toon = toonJson();
  const pub = path.join(tmp, "public");
  mkdirSync(pub);
  const fontDir = path.join(root, "infra/render/fonts");
  const faces: [string, string, string][] = [];
  for (const [family, file, extra] of [
    ["Anton", "Anton-Regular.ttf", ""], ["Bangers", "Bangers-Regular.ttf", ""], ["Inter", "Inter-Variable.ttf", "font-weight:100 900;"],
    ["Nunito", "Nunito-Variable.ttf", "font-weight:200 1000;"], ["Fraunces", "Fraunces-Variable.ttf", "font-weight:100 900;"],
    ["Fraunces", "Fraunces-Italic-Variable.ttf", "font-weight:100 900;font-style:italic;"],
  ] as const) {
    cpSync(path.join(fontDir, file), path.join(pub, file));
    faces.push([family, file, extra]);
  }
  const entry = path.join(tmp, "entry.tsx");
  writeFileSync(
    entry,
    `import { registerRoot, staticFile } from "remotion";\nimport { TsxRoot } from ${JSON.stringify(path.join(root, "remotion/kit/tsx-root"))};\n` +
      `const faces: [string, string, string][] = ${JSON.stringify(faces)};\nconst st = document.createElement("style");\n` +
      "st.textContent = faces.map(([f, file, extra]) => `@font-face{font-family:'${f}';src:url(${staticFile(file)});${extra}font-display:block}`).join('\\n');\n" +
      `document.head.appendChild(st);\nregisterRoot(TsxRoot);\n`,
  );
  const lib = path.join(root, "remotion/kit/tsxlib/index.ts");
  const kitDir = path.join(root, "remotion/kit");
  const alias: Record<string, string> = { "tsx-scene$": path.join(exDir, "video.tsx"), "yt-kit$": lib };
  for (const f of readdirSync(path.join(kitDir, "toon")).filter((x) => /^(core|fx|comic|anime|manga|paper|painted)\.tsx$/.test(x))) alias[`yt-toon/${f.replace(/\.tsx$/, "")}$`] = path.join(kitDir, "toon", f);
  const serveUrl = await bundle({
    entryPoint: entry,
    publicDir: pub,
    rootDir: root,
    outDir: path.join(tmp, "bundle"),
    enableCaching: false,
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, alias: { ...(c.resolve?.alias ?? {}), ...alias } } }),
  });
  const total = Math.ceil(TL.total * 30);
  const inputProps = { props: {}, frames: total, captions: [], style: "cartoon_comic", orientation: toon.orientation, toon };
  const chromiumOptions = { gl: "swangle" as const };
  const composition = await selectComposition({ serveUrl, id: "tsx-video", inputProps, chromiumOptions });
  const files: string[] = [];
  for (const t of times) {
    const f = path.join(tmp, `ours-${t}.png`);
    await renderStill({ composition, serveUrl, frame: Math.round(t * 30), output: f, imageFormat: "png", inputProps, chromiumOptions, overwrite: true });
    files.push(f);
  }
  return files;
}

function diff(a: string, b: string): number {
  const x = PNG.sync.read(readFileSync(a));
  const y = PNG.sync.read(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height) return 255;
  let sum = 0;
  for (let i = 0; i < x.data.length; i += 4) sum += Math.abs(x.data[i]! - y.data[i]!) + Math.abs(x.data[i + 1]! - y.data[i + 1]!) + Math.abs(x.data[i + 2]! - y.data[i + 2]!);
  return sum / ((x.data.length / 4) * 3);
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "toon-compare-"));
  try {
    const up = await upstream(tmp);
    const mine = await ours(tmp);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const diffs = times.map((_, i) => diff(up[i]!, mine[i]!));
    // sheet: upstream | port for every frame, 4 pairs across
    times.forEach((t, i) => {
      spawnSync("ffmpeg", ["-v", "error", "-y", "-i", up[i]!, "-i", mine[i]!, "-filter_complex", "[0]scale=270:480[a];[1]scale=270:480[b];[a][b]hstack", path.join(out, `pair-${String(i).padStart(3, "0")}.png`)]);
      console.log(`t=${t}s diff ${diffs[i]!.toFixed(2)}/255`);
    });
    const rows = Math.ceil(times.length / 4);
    spawnSync("ffmpeg", ["-v", "error", "-y", "-framerate", "1", "-i", path.join(out, "pair-%03d.png"), "-vf", `tile=4x${rows}:padding=6:color=white`, "-frames:v", "1", path.join(out, "sheet.png")]);
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const worst = Math.max(...diffs);
    const at = times[diffs.indexOf(worst)];
    console.log(`frames=${diffs.length} mean=${mean.toFixed(2)}/255 worst=${worst.toFixed(2)}/255 at ${at}s -> ${path.join(out, "sheet.png")}`);
    const pass = mean <= MEAN_MAX && worst <= WORST_MAX;
    console.log(pass ? "PASS" : "FAIL");
    if (!pass) process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
