// Side-by-side check for the owner (old-kit-import): draws frames of old shorts through the engine's locked renderer (yt-old
// libraries) and, where the old app's own render exists, puts the same moment from it on the left. Saves PNGs under
// .data/compare/<short>/. Needs Docker with the render image and ffmpeg.   npx tsx scripts/old-kit-compare.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { renderTsxStills, type TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";

const run = promisify(execFile);
const OLD = path.resolve("../claude-faceless-shorts-creator");
const SHORTS: Array<{ name: string; frames: number[]; oldVideo?: string }> = [
  { name: "short-18", frames: [0, 180, 360, 540, 720, 900, 1080, 1229], oldVideo: path.join(OLD, "shorts/short-18-window-never-grows/output/short-18-silent.mp4") },
  { name: "short-13", frames: [0, 180, 360, 540, 720, 900, 1080, 1229] },
  { name: "short-14", frames: [0, 180, 360, 540, 720, 900, 1080, 1259] },
];

async function main(): Promise<void> {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "old-kit-compare-")));
  const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
  try {
    for (const s of SHORTS) {
      const attemptDir = path.join(root, s.name);
      mkdirSync(attemptDir, { recursive: true });
      const ctx = { stage: { name: "tsx_author", videoId: "v" }, claim: { stageRunId: `compare-${s.name}`, fence: 1, workerId: "c" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir, log: () => undefined } as unknown as StageContext;
      const r = await renderTsxStills(deps, ctx, { source: readFileSync(`tests/fixtures/old-shorts/${s.name}.tsx`, "utf8"), frames: s.frames });
      if (!r.ok) throw new Error(`${s.name}: ${r.message} ${r.problems.join(" | ")}`);
      const out = path.resolve(".data/compare", s.name);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      for (const [i, f] of s.frames.entries()) {
        const fresh = r.files[i]!;
        const dest = path.join(out, `frame-${String(f).padStart(4, "0")}.png`);
        if (s.oldVideo && existsSync(s.oldVideo)) {
          const old = path.join(attemptDir, `old-${f}.png`);
          await run("ffmpeg", ["-v", "error", "-y", "-ss", String(f / 30), "-i", s.oldVideo, "-frames:v", "1", old]);
          // old app on the left, new engine on the right, both scaled to half size
          await run("ffmpeg", ["-v", "error", "-y", "-i", old, "-i", fresh, "-filter_complex", "[0]scale=540:960[a];[1]scale=540:960[b];[a][b]hstack", dest]);
        } else {
          await run("ffmpeg", ["-v", "error", "-y", "-i", fresh, "-vf", "scale=540:960", dest]);
        }
      }
      console.log(`${s.name}: ${s.frames.length} frames -> ${out}${s.oldVideo ? " (old | new)" : " (new only: the old app kept no render of it)"}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
