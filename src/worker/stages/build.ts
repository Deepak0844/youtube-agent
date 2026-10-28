import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCostPlan, costPlanBody, type CostItem } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import type { AttemptHandler } from "./attempt";
import { contentBody, DEFAULTS, loadVideo, plainScope, scopeHeadroom, videoMoneyScopes, type StageDeps } from "./deps";

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/**
 * Build: reads the script and beats, plans what Generate will buy, and writes the cost plan the owner approves. Nothing is
 * bought here. A plan that cannot fit under the per-video, daily or monthly cap is refused BEFORE any money moves, so the
 * owner is never asked to approve a figure the engine would refuse to spend.
 */
export function buildAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    await contentBody(deps.db, video.id, "script");
    const { beats } = await contentBody<{ beats?: Array<{ id?: unknown }> }>(deps.db, video.id, "beats");
    const beatIds = (Array.isArray(beats) ? beats : []).map((b, i) => (typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`));

    const count = Math.max(1, Math.min(beatIds.length, deps.maxImages ?? DEFAULTS.maxImages));
    const items: CostItem[] = Array.from({ length: count }, () => ({
      kind: "image",
      provider: deps.imageProvider ?? DEFAULTS.imageProvider,
      quoteMicroUsd: deps.imageQuoteMicroUsd ?? DEFAULTS.imageQuoteMicroUsd,
    }));
    let plan;
    try {
      plan = buildCostPlan(items, video.kind);
    } catch (e) {
      throw new KnownFailure(e instanceof Error ? e.message : "the cost plan could not be built");
    }

    const room = await scopeHeadroom(deps.db, await videoMoneyScopes(deps.db, video));
    if (plan.totalMicroUsd > room.micro) {
      throw new KnownFailure(`plan_over_the_cap: this plan would cost ${usd(plan.totalMicroUsd)} but only ${usd(room.micro)} is left under ${plainScope(room.scope)}. Nothing was spent.`);
    }

    // A stub scene file: Phase 4 replaces it with the real scene kit. It names the beats the images are for.
    await writeFile(path.join(ctx.attemptDir, "scene.json"), JSON.stringify({ version: 1, kind: video.kind, beats: beatIds, images: count }));
    return {
      files: ["scene.json"],
      content: [{ kind: "cost_plan", body: costPlanBody(plan) }],
      result: { items: items.length, totalMicroUsd: plan.totalMicroUsd },
    };
  };
}
