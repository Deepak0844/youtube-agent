// Manual smoke run of the engine (ADR 0015): ONE real Claude Code build run on the owner's subscription with the real engine
// tools (code check, preview frames drawn in the locked render container). Uses a throwaway video row that is deleted at the
// end. Needs: claude logged in, Docker with the render image, migrations applied.
//   npm run engine:smoke
//   npm run engine:smoke -- --openmontage ["topic"]   OpenMontage parity, Phase B: one Explainer through the openmontage-pipeline
//     skill up to the edit stage; the om/ artifacts are copied to .data/compare/om-phase-b/om (check: scripts/om-phase-b-check.ts)
import { execFile } from "node:child_process";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTsx } from "@/server/core/tsx-check";
import type { StageContext } from "@/server/core/stage-handler";
import { getEngineConfig } from "@/server/db/engine-config";
import { getPool } from "@/server/db/pool";
import { createVideoRow } from "@/server/db/videos";
import { engineTools } from "@/server/engine/mcp/tools";
import { runEngine } from "@/server/engine/run";
import { defaultEngineRoot } from "@/server/engine/workspace";
import { probeVideo } from "@/server/render/probe";
import { runChild } from "@/server/render/child";
import { renderTsxStills, typeCheckInThread, type TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { omDurationFrames, renderOm } from "@/server/providers/renderer/om-render";
import { resolveRenderImage } from "@/server/providers/renderer/remotion-container";
import { storageRoot } from "@/server/storage/paths";
import { renderKitDir } from "@/worker/handlers";
import { GOOD_SCENE } from "../tests/fixtures/tsx-good-scene";

/** Length of a staged media file in seconds (ffprobe, local files only), or null. */
function probeDurationS(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-show_entries", "format=duration", "-of", "csv=p=0", file], { timeout: 20_000 }, (err, out) => {
      const d = Number(String(out).trim());
      resolve(!err && Number.isFinite(d) && d > 0 ? d : null);
    });
  });
}

async function main(): Promise<void> {
  const db = getPool();
  const config = await getEngineConfig(db);
  const root = storageRoot();
  const video = await createVideoRow(db, { format: "short", kind: "tsx", language: "en", topic: "Engine smoke test (deleted after)" });
  const attemptDir = await realpath(await mkdtemp(path.join(tmpdir(), "engine-smoke-"))); // macOS /var is a link; the renderer refuses linked paths
  const ac = new AbortController();
  const ctx = { stage: { name: "tsx_author", videoId: video.id }, claim: { stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", fence: 1, workerId: "smoke" }, config, signal: ac.signal, attemptDir, log: (l: string) => console.log(`  [render] ${l}`) } as unknown as StageContext;
  const image = resolveRenderImage();
  const tsxDeps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), image: () => image, workerId: "smoke", probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
  const omAt = process.argv.indexOf("--openmontage");
  const omTopic = omAt > 0 ? (process.argv[omAt + 1] ?? "Why we need Docker") : null;
  let workDir = "";
  try {
    const toolsPrompt = [
      "This is a test of your tools. Do exactly these steps:",
      "1. Write the scene below into the file scene/video.tsx, unchanged.",
      "2. Call check_code on scene/video.tsx.",
      "3. Call preview_frames on scene/video.tsx with frames [0, 135].",
      "4. Answer with one sentence per frame saying what you see.",
      "5. Then name the skills you have, list the folders in ref/examples, and name three libraries from ref/lib/index.md.",
      "",
      "```tsx",
      GOOD_SCENE,
      "```",
    ].join("\n");
    const omPrompt = [
      `Make a 40-second vertical (1080x1920) Explainer short on "${omTopic}" with the openmontage-pipeline skill.`,
      "This is a test run of the pipeline. Rules for it:",
      "- This build run has no web access: for the research stage use your own knowledge and say so in the research brief.",
      "- Work the animated-explainer pipeline's stages in order through the edit stage, then only the compose stage's step that assembles the composition JSON (om/composition.json); do not render; skip publish.",
      "- Write every stage artifact to om/, valid against its schema, and a checkpoint per stage.",
      "- Where a stage asks for human approval, pick the recommended option yourself, note it in the checkpoint, and go on (do not stop).",
      "- Style playbook: flat-motion-graphics. There is no narration audio yet: leave audio empty.",
      "- Run check_scenes and fix the files until its last line is VERDICT: pass.",
      "Finish with a short summary: the stages done, the files written, which guides you read, and the last check_scenes verdict.",
    ].join("\n");
    const prompt = omTopic ? omPrompt : toolsPrompt;
    const started = Date.now();
    const r = await runEngine(
      {
        db, root: defaultEngineRoot(), config: { ...config.engine, enabled: true },
        tools: (ws) => (workDir = ws.workDir, engineTools({
          workDir: ws.workDir,
          check: async (src) => { const c = checkTsx(src); return c.ok ? typeCheckInThread(src, 60_000) : c; },
          stills: (src, frames) => renderTsxStills(tsxDeps, ctx, { source: src, frames }),
          listAssets: async () => [],
          assetFile: async () => null,
          probeDuration: (file) => probeDurationS(file),
          orientation: "portrait",
          omStills: async (props, orientation, frames, assets) => {
            const r = await renderOm(tsxDeps, ctx, { props, orientation, stills: frames, assets, outFile: "om.mp4" });
            return r.ok ? { ok: true, files: r.stills.map((n) => path.join(attemptDir, n)), frameCount: omDurationFrames(props) } : { ok: false, message: r.message, problems: r.problems };
          },
        })),
      },
      { videoId: video.id, stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", kind: "build", prompt, long: false, signal: ac.signal },
    );
    console.log(`\nresult after ${Math.round((Date.now() - started) / 1000)} s:`);
    console.log(JSON.stringify(r, null, 2));
    if (omTopic && workDir) {
      const out = path.resolve(".data/compare/om-phase-b");
      await rm(out, { recursive: true, force: true });
      await cp(path.join(workDir, "om"), path.join(out, "om"), { recursive: true }).catch((e) => console.log(`no om/ folder: ${e}`));
      await cp(path.join(workDir, "assets"), path.join(out, "assets"), { recursive: true }).catch(() => undefined);
      console.log(`om artifacts -> ${out}`);
    }
  } finally {
    await db.query("delete from videos where id = $1", [video.id]).catch(() => undefined);
    await rm(path.join(root, "videos", video.id), { recursive: true, force: true });
    await rm(path.join(defaultEngineRoot(), "videos", video.id), { recursive: true, force: true });
    await rm(attemptDir, { recursive: true, force: true });
    await db.end();
  }
}

void main();
