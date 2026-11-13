// Side-by-side parity check (OpenMontage parity, Phase A): draws frames of an OpenMontage scene list through this app's locked
// renderer (renderOm) and puts the same frame from OpenMontage's own render on the left. Prints the mean pixel difference per
// frame (0-255). Saves PNGs under .data/compare/om-<name>-<orientation>/. Needs Docker with the render image, and ffmpeg.
//   npx tsx scripts/om-compare.ts <props.json> <openmontage-render.mp4> [portrait]
// The reference render comes from OpenMontage's own CLI (dev only, in the upstream clone):
//   cd ~/Personal/openmontage-upstream/remotion-composer && npm ci && npx remotion render src/index.tsx Explainer <out.mp4> --props=<props.json> [--width=1080 --height=1920]
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { omDurationFrames, renderOm } from "@/server/providers/renderer/om-render";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";

const run = promisify(execFile);

/** Mean absolute difference of two same-size PNGs, 0-255 over all RGB values. */
export function meanDiff(a: string, b: string): number {
  const x = PNG.sync.read(readFileSync(a));
  const y = PNG.sync.read(readFileSync(b));
  if (x.width !== y.width || x.height !== y.height) return 255;
  let sum = 0;
  for (let i = 0; i < x.data.length; i += 4) sum += Math.abs(x.data[i]! - y.data[i]!) + Math.abs(x.data[i + 1]! - y.data[i + 1]!) + Math.abs(x.data[i + 2]! - y.data[i + 2]!);
  return sum / ((x.data.length / 4) * 3);
}

async function main(): Promise<void> {
  const [propsFile, refVideo, orient] = process.argv.slice(2);
  if (!propsFile || !refVideo) throw new Error("usage: om-compare.ts <props.json> <openmontage-render.mp4> [portrait]");
  const orientation = orient === "portrait" ? "portrait" : "landscape";
  const props = JSON.parse(readFileSync(propsFile, "utf8")) as Record<string, unknown>;
  const n = omDurationFrames(props);
  const frames = [...new Set([0, 15, 45, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.7), Math.floor(n * 0.9), n - 1])].sort((a, b) => a - b);
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "om-compare-")));
  const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
  const ctx = { stage: { name: "om", videoId: "v" }, claim: { stageRunId: "om-compare", fence: 1, workerId: "c" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir: root, log: () => undefined } as unknown as StageContext;
  try {
    const r = await renderOm(deps, ctx, { props, orientation, outFile: "x.mp4", stills: frames });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    const out = path.resolve(".data/compare", `om-${path.basename(propsFile, ".json")}-${orientation}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const half = orientation === "portrait" ? "540:960" : "960:540";
    for (const [i, f] of frames.entries()) {
      const ours = path.join(root, r.stills[i]!);
      const ref = path.join(root, `ref-${f}.png`);
      // the exact frame f of the reference video
      await run("ffmpeg", ["-v", "error", "-y", "-i", refVideo, "-vf", `select=eq(n\\,${f})`, "-fps_mode", "passthrough", "-frames:v", "1", ref]);
      const d = meanDiff(ref, ours);
      await run("ffmpeg", ["-v", "error", "-y", "-i", ref, "-i", ours, "-filter_complex", `[0]scale=${half}[a];[1]scale=${half}[b];[a][b]hstack`, path.join(out, `frame-${String(f).padStart(4, "0")}.png`)]);
      console.log(`frame ${f}: mean difference ${d.toFixed(2)} / 255`);
    }
    console.log(`${frames.length} frames -> ${out} (OpenMontage | this app)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
