import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCostPlan, costPlanBody, type CostItem } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import { buildSceneDoc, type AskScene } from "@/server/core/scene-build";
import type { Message } from "@/server/core/agent-loop";
import type { LlmClient, LlmStageContext } from "@/server/llm/client";
import type { AttemptHandler, OutContent } from "./attempt";
import { approvedScript } from "@/server/db/stage-content";
import { DEFAULTS, loadVideo, plainScope, scopeHeadroom, videoMoneyScopes, type StageDeps } from "./deps";

const SCENE_MAX_OUTPUT_TOKENS = 1500;
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** One reserved, paid model call per answer. A budget refusal or unclear outcome goes up as is: the runner parks the stage for the owner (needs_decision). Never retried here. Repair uses the same path. */
export function sceneAsk(llm: LlmClient, ctx: LlmStageContext): AskScene {
  return async (messages: Message[]) => (await llm.agent(ctx, { stage: "build_scene_kit", tools: [], messages, maxSteps: 1, maxOutputTokens: SCENE_MAX_OUTPUT_TOKENS })).text;
}

/**
 * Build: reads the script and beats, plans what Generate will buy, and writes the cost plan the owner approves. Nothing is
 * bought here. A plan that cannot fit under the per-video, daily or monthly cap is refused BEFORE any money moves, so the
 * owner is never asked to approve a figure the engine would refuse to spend.
 */
export function buildAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const beatIds = script.beats.map((b, i) => (typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`));

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

    // The old stub scene file (Render still reads it until it switches to scenes.json). It names the beats the images are for.
    await writeFile(path.join(ctx.attemptDir, "scene.json"), JSON.stringify({ version: 1, kind: video.kind, beats: beatIds, images: count }));
    const content: OutContent[] = [{ kind: "cost_plan", body: costPlanBody(plan) }];
    const files = ["scene.json"];
    if (deps.makeLlm) {
      // Scenes: one reserved model call per attempt, per beat. A budget refusal or a bad scene fails the stage with no scenes file.
      const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
      const beats = script.beats.map((b, i) => ({ id: beatIds[i]!, text: typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "" }));
      const ask = sceneAsk(llm, ctx);
      const doc = await buildSceneDoc(beats, ask, { assets: (await deps.sceneAssets?.(video.id)) ?? [] });
      await writeFile(path.join(ctx.attemptDir, "scenes.json"), JSON.stringify(doc));
      files.push("scenes.json");
      content.push({ kind: "scenes", body: doc });
    } else {
      ctx.log("build: no scene model is wired, so scenes were skipped (only the cost plan was made)");
    }
    return { files, content, result: { items: items.length, totalMicroUsd: plan.totalMicroUsd, scenes: deps.makeLlm !== undefined } };
  };
}
