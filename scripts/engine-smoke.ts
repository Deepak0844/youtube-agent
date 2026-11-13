// Manual smoke run of the engine (ADR 0015): ONE real Claude Code build run on the owner's subscription with the real engine
// tools (code check, preview frames drawn in the locked render container). Uses a throwaway video row that is deleted at the
// end. Needs: claude logged in, Docker with the render image, migrations applied.
//   npm run engine:smoke
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { resolveRenderImage } from "@/server/providers/renderer/remotion-container";
import { storageRoot } from "@/server/storage/paths";
import { renderKitDir } from "@/worker/handlers";
import { GOOD_SCENE } from "../tests/fixtures/tsx-good-scene";

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
  try {
    const prompt = [
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
    const started = Date.now();
    const r = await runEngine(
      {
        db, root: defaultEngineRoot(), config: { ...config.engine, enabled: true },
        tools: (ws) => engineTools({
          workDir: ws.workDir,
          check: async (src) => { const c = checkTsx(src); return c.ok ? typeCheckInThread(src, 60_000) : c; },
          stills: (src, frames) => renderTsxStills(tsxDeps, ctx, { source: src, frames }),
          listAssets: async () => [],
          assetFile: async () => null,
        }),
      },
      { videoId: video.id, stageRunId: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91", kind: "build", prompt, long: false, signal: ac.signal },
    );
    console.log(`\nresult after ${Math.round((Date.now() - started) / 1000)} s:`);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await db.query("delete from videos where id = $1", [video.id]).catch(() => undefined);
    await rm(path.join(root, "videos", video.id), { recursive: true, force: true });
    await rm(path.join(defaultEngineRoot(), "videos", video.id), { recursive: true, force: true });
    await rm(attemptDir, { recursive: true, force: true });
    await db.end();
  }
}

void main();
