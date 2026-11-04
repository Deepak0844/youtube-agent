import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { buildScale3dScene } from "@/server/core/scale3d-build";
import { scaleItemSchema } from "@/server/core/script-contract";
import type { LlmClient, LlmStageContext } from "@/server/llm/client";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

const SCALE3D_MAX_OUTPUT_TOKENS = 4000;

/** One reserved, paid model call per attempt, through the build_scale3d route (plain text back). A budget refusal or an unclear outcome goes up as is: the runner parks the stage for the owner. Never retried here. */
export function scale3dAsk(llm: LlmClient, ctx: LlmStageContext): (messages: Message[]) => Promise<string> {
  return async (messages) => (await llm.agent(ctx, { stage: "build_scale3d", tools: [], messages, maxSteps: 1, maxOutputTokens: SCALE3D_MAX_OUTPUT_TOKENS })).text;
}

/**
 * Build for a scale3d video: reads the approved script (its narration and scale list), has the model plan the beats, checks the
 * result with validateScale3d and stores it as the `scenes` content (body {kind: "scale3d", scene}) plus scale3d.json for Render.
 * Three attempts at most, then the stage fails with a plain message: it never falls back to another video kind.
 */
export function buildScale3dAttempt(deps: StageDeps, script: Record<string, unknown>): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No scene model is wired, so the 3D scene cannot be written.");
    const scale = z.array(scaleItemSchema).min(2).safeParse(script.scale);
    if (!scale.success) throw new KnownFailure("The approved script has no valid 3D scale list. Send the script back for a new draft.");
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, await loadVideo(deps.db, ctx)));
    const out = await buildScale3dScene(
      scale3dAsk(llm, ctx),
      { title: typeof script.title === "string" ? script.title : "", narration: typeof script.narration === "string" ? script.narration : "", scale: scale.data },
      ctx.log,
    );
    await writeFile(path.join(ctx.attemptDir, "scale3d.json"), JSON.stringify(out.scene));
    return {
      files: ["scale3d.json"],
      content: [{ kind: "scenes", body: { kind: "scale3d", scene: out.scene } }],
      result: { kind: "scale3d", objects: out.scene.objects.length, beats: out.scene.beats.length, attempts: out.attempts },
    };
  };
}
