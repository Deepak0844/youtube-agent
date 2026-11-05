import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { directScene3d } from "@/server/core/scene3d-direct";
import { STORY_LIMITS, storyBeatSchema } from "@/server/core/script-contract";
import type { LlmClient, LlmStageContext } from "@/server/llm/client";
import { approvedScript } from "@/server/db/stage-content";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

const DIRECT_MAX_OUTPUT_TOKENS = 8000;

/** One reserved, paid model call per attempt, through the direct_scene3d route (plain text back). A budget refusal or an unclear outcome goes up as is: the runner parks the stage for the owner. Never retried here. */
export function directAsk(llm: LlmClient, ctx: LlmStageContext): (messages: Message[]) => Promise<string> {
  return async (messages) => (await llm.agent(ctx, { stage: "direct_scene3d", tools: [], messages, maxSteps: 1, maxOutputTokens: DIRECT_MAX_OUTPUT_TOKENS })).text;
}

/**
 * Director for a scene3d video: reads the approved script (its story), finds catalogue candidates, has the model write the scene,
 * checks it and stores it as the `scenes` content (body {kind: "scene3d", scene, missing_assets}) plus scene3d.json for Render.
 * Three attempts at most, then the stage fails with a plain message: it never falls back to another video kind.
 */
export function directScene3dAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.makeLlm) throw new KnownFailure("No scene model is wired, so the 3D scene cannot be written.");
    if (!deps.catalog3d) throw new KnownFailure("The 3D model catalogue is not wired, so the 3D scene cannot be written.");
    const video = await loadVideo(deps.db, ctx);
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const story = z.array(storyBeatSchema).min(STORY_LIMITS.minBeats).max(STORY_LIMITS.maxBeats).safeParse(script.script.story);
    if (!story.success) throw new KnownFailure("The approved script has no valid 3D story. Send the script back for a new draft.");
    const catalog = await deps.catalog3d().catch(() => {
      throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json).");
    });
    const llm = deps.makeLlm(await videoMoneyScopes(deps.db, video));
    const out = await directScene3d(
      directAsk(llm, ctx),
      { title: typeof script.script.title === "string" ? script.script.title : "", story: story.data.map((b) => ({ id: b.id, visual: b.visual, line: b.line })), catalog },
      ctx.log,
    );
    await writeFile(path.join(ctx.attemptDir, "scene3d.json"), JSON.stringify(out.scene));
    return {
      files: ["scene3d.json"],
      content: [{ kind: "scenes", body: { kind: "scene3d", scene: out.scene, missing_assets: out.missing } }],
      result: { kind: "scene3d", elements: out.scene.elements.length, shots: out.scene.shots.length, models: out.modelIds.length, candidates: out.candidates, missing_assets: out.missing.length, attempts: out.attempts },
    };
  };
}
