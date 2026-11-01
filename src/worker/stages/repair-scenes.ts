import { KnownFailure } from "@/server/core/paid-call";
import type { StageHandler } from "@/server/core/stage-handler";
import { currentScenes, repairScenes } from "@/server/db/scene-repair";
import { sceneAsk } from "./build";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * On-demand repair (never in the automatic route): asks the model to fix only the scenes that fail the checks, in the same
 * reserved, budget-scoped way Build asks for scenes. repairScenes saves a NEW scenes version itself, only if every check
 * passes. A model that is not routed or priced is refused by the LLM client before anything is reserved.
 */
export function repairScenesAttempt(deps: StageDeps): StageHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No scene model is wired, so scenes cannot be repaired.");
    const video = await loadVideo(deps.db, ctx);
    const req = await deps.db.query<{ result: { request?: { sceneIds?: unknown } } | null }>("select result from stage_runs where id = $1", [ctx.claim.stageRunId]);
    const ids = req.rows[0]?.result?.request?.sceneIds;
    const sceneIds = Array.isArray(ids) && ids.every((x) => typeof x === "string") && ids.length > 0 ? (ids as string[]) : undefined;
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const res = await repairScenes(deps.db, video.id, sceneAsk(llm, ctx), { sceneIds, assets: deps.sceneAssets });
    if (!res.ok) throw new KnownFailure(res.message);
    const total = (await currentScenes(deps.db, video.id))?.body.scenes.length ?? res.changed.length;
    return { changed: res.changed, untouched: total - res.changed.length, version: res.version };
  };
}
