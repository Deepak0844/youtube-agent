import type pg from "pg";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext, StageHandler } from "@/server/core/stage-handler";
import { draftModeForStage, ensureDraftScopes, loadDraftVideo, pendingScriptFeedback, saveDraftContent } from "@/server/db/draft-store";
import type { LlmClient } from "@/server/llm/client";
import { agentDraft } from "./agent-mode";
import { searchThenWrite } from "./search-then-write";
import type { DraftDeps, DraftInput, DraftResult, WebTools } from "./shared";

export { DraftInvalidError } from "./shared";
export type { DraftDeps, DraftInput, DraftResult } from "./shared";

/** Draft (Doc 2 §8). Mode = the routed model's `draft_mode`; no route or an unknown value means search-then-write. */
export async function runDraft(ctx: StageContext, deps: DraftDeps, input: DraftInput): Promise<DraftResult> {
  const full = { ...input, format: input.format ?? ("short" as const) };
  const mode = deps.mode ?? (await draftModeForStage(deps.db, "draft"));
  return mode === "agent" ? agentDraft(ctx, deps, full) : searchThenWrite(ctx, deps, full);
}

/**
 * The `draft` stage handler: reads the video, drafts, saves script / beats / evidence versions (once per stage run).
 * `makeLlm` gets this run's budget scopes (per run, per video, per UTC day and month).
 */
export function createDraftHandler(d: { db: pg.Pool; makeLlm: (budgetScopes: string[]) => LlmClient; makeWeb: () => WebTools }): StageHandler {
  return async (ctx) => {
    const videoId = ctx.stage.videoId;
    if (!videoId) throw new KnownFailure("draft needs a video");
    const video = await loadDraftVideo(d.db, videoId);
    if (!video) throw new KnownFailure("The video for this draft no longer exists.");
    const scopes = await ensureDraftScopes(d.db, { stageRunId: ctx.stage.id, videoId, kind: video.kind, format: video.format }).catch((e: unknown) => {
      throw new KnownFailure(e instanceof Error ? e.message : "budget caps for Draft are not set up");
    });
    const feedback = await pendingScriptFeedback(d.db, videoId);
    const { script, spentMicroUsd } = await runDraft(
      ctx,
      { llm: d.makeLlm(scopes), web: d.makeWeb(), db: d.db },
      { topic: video.topic, lang: video.language, kind: video.kind, format: video.format, ...(video.notes ? { notes: video.notes } : {}), ...(feedback ? { feedback } : {}) },
    );
    const versions = await saveDraftContent(d.db, videoId, ctx.claim, script);
    return { title: script.title, spentMicroUsd, versions };
  };
}
