import path from "node:path";
import type { StageContext } from "@/server/core/stage-handler";
import { checkTsx } from "@/server/core/tsx-check";
import { engineAssetFile, engineListAssets } from "@/server/db/engine-assets";
import type { Db } from "@/server/db/stages";
import { omDurationFrames, renderOm } from "@/server/providers/renderer/om-render";
import { renderTsx, renderTsxStills, typeCheckInThread, type TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { mediaDurationS } from "@/server/render/media-duration";
import { engineTools } from "./mcp/tools";
import type { McpTool } from "./mcp/protocol";

// The seven engine tools with their production dependencies (ADR 0015, OpenMontage parity Phase C): the code check and
// type-check, previews of code scenes and of OpenMontage compositions in the locked render box, the app's licence-checked
// libraries, and the safe media probe. Phase D's video steps call this for each build run.

export interface EngineToolsOptions {
  db: Db;
  ctx: StageContext;
  workDir: string;
  orientation: "portrait" | "landscape";
  /** The storage root (the asset and audio libraries live under it). */
  storageRoot: string;
  /** The locked renderer's dependencies (kit, child runner, image, probe), as the render steps use them. */
  render: TsxRendererDeps;
  /** The video's yt-kit style id for code-scene previews. */
  style?: string | null;
}

export function buildEngineTools(o: EngineToolsOptions): McpTool[] {
  return engineTools({
    workDir: o.workDir,
    orientation: o.orientation,
    check: async (src) => {
      const c = checkTsx(src);
      return c.ok ? typeCheckInThread(src, 60_000) : c;
    },
    preflight: async (src) => {
      const r = await renderTsx(o.render, o.ctx, { source: src, outFile: "preflight.mp4", style: o.style ?? null, preflightOnly: true });
      return r.ok ? { ok: true, problems: [] } : { ok: false, problems: [r.error.message, ...r.error.problems] };
    },
    stills: (src, frames) => renderTsxStills(o.render, o.ctx, { source: src, frames, style: o.style ?? null }),
    omStills: async (props, orientation, frames, assets) => {
      const r = await renderOm(o.render, o.ctx, { props, orientation, stills: frames, assets, outFile: "om-preview.mp4" });
      return r.ok ? { ok: true, files: r.stills.map((n) => path.join(o.ctx.attemptDir, n)), frameCount: omDurationFrames(props) } : { ok: false, message: r.message, problems: r.problems };
    },
    listAssets: (kind, query) => engineListAssets(o.db, kind, query),
    assetFile: (id) => engineAssetFile(o.db, o.storageRoot, id),
    probeDuration: (file) => mediaDurationS(file, { runChild: (spec) => o.render.runChild(spec), signal: o.ctx.signal, stageRunId: o.ctx.claim.stageRunId }),
  });
}
