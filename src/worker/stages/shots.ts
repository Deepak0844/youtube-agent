import { beatWindows, planShots } from "@/server/core/ai-shots";
import { buildCostPlan, costPlanBody, type CostItem } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import { approvedScript } from "@/server/db/stage-content";
import { resolveRoute } from "@/server/db/media-registry";
import { characterOf } from "@/server/db/video-characters";
import { pickVideoModel } from "@/server/providers/video";
import type { AttemptHandler } from "./attempt";
import { contentBody, loadVideo, plainScope, scopeHeadroom, videoMoneyScopes, type StageDeps } from "./deps";

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/**
 * Shots: plans one clip per beat (as long as the beat's narration) and prices every clip. Nothing is bought here: the plan is the cost plan the owner
 * approves, and a plan that cannot fit under the caps is refused BEFORE the owner is asked to approve a figure the engine would refuse to spend.
 * A beat with no visual sentence, a missing route or model, an unpriced model or narration that does not line up with the beats stops the plan with a plain sentence.
 */
export function shotsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "ai") throw new KnownFailure("Only an AI video has a shot plan.");
    if (!deps.videoFor) throw new KnownFailure("AI video is not set up in this app yet.");
    const route = await resolveRoute(deps.db, "video", { format: video.format, videoKind: video.kind });
    if (!route?.model) throw new KnownFailure("Pick an AI video provider and model for AI videos in Settings → Providers.");
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const beats = script.beats.map((b, i) => {
      const x = (b ?? {}) as { id?: unknown; text?: unknown; visual?: unknown };
      return { id: typeof x.id === "string" && x.id !== "" ? x.id : `beat-${i + 1}`, text: typeof x.text === "string" ? x.text : "", visual: typeof x.visual === "string" ? x.visual : undefined };
    });
    const captions = await contentBody<{ words?: unknown }>(deps.db, video.id, "captions").catch(() => null);
    const words = (Array.isArray(captions?.words) ? captions.words : []).filter(
      (w): w is { startS: number; endS: number } => typeof (w as { startS?: unknown })?.startS === "number" && typeof (w as { endS?: unknown })?.endS === "number",
    );
    const windows = beatWindows(words, beats);
    if (!windows) throw new KnownFailure("The narration and the beats do not line up well enough to time the clips. Make the narration again, or edit the script.");

    const provider = await deps.videoFor(route.provider); // refuses (nothing reserved) when off, unpriced or without a key
    const model = Object.hasOwn(provider.capability.models, route.model) ? provider.capability.models[route.model] : undefined;
    if (!model) throw new KnownFailure(`The model "${route.model.slice(0, 60)}" is not one this provider offers. Pick another in Settings → Providers.`);
    // A locked character: every clip starts from that picture, so only a model that can start from a picture may be used (no fallback, never re-drawn from words).
    const character = await characterOf(deps.db, video.id);
    pickVideoModel({ [route.provider]: provider }, route.provider, route.model, { locked: character !== null });
    const plan = planShots(beats, windows, model);
    if (!plan.ok) throw new KnownFailure(plan.problems.join(" "));

    const items: CostItem[] = plan.shots.map((s) => ({
      kind: "clip",
      provider: `${route.provider}/${route.model}`,
      quoteMicroUsd: provider.quote({ prompt: s.prompt, seconds: s.seconds, aspect: "9:16", startImage: character !== null, endImage: false, model: route.model!, budgetScopes: ["quote"], ...(character && { startImagePath: character.storageRef }) }),
    }));
    const cost = buildCostPlan(items, "ai");
    const room = await scopeHeadroom(deps.db, await videoMoneyScopes(deps.db, video));
    if (cost.totalMicroUsd > room.micro) {
      throw new KnownFailure(`plan_over_the_cap: these clips would cost ${usd(cost.totalMicroUsd)} but only ${usd(room.micro)} is left under ${plainScope(room.scope)}. Nothing was spent.`);
    }
    return {
      files: [],
      content: [{ kind: "cost_plan", body: { ...costPlanBody(cost), shots: plan.shots, ...(character && { character }) } }],
      result: { clips: items.length, totalMicroUsd: cost.totalMicroUsd, provider: route.provider, model: route.model },
    };
  };
}
