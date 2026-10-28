import type { LanguageModel } from "ai";
import type pg from "pg";
import { createDraftHandler } from "@/server/authoring/draft";
import type { StepResult } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import type { ModelRow } from "@/server/core/llm-catalog";
import type { StageHandler } from "@/server/core/stage-handler";
import { loadDraftVideo } from "@/server/db/draft-store";
import { fakeDraft, fakeModelStep } from "@/server/llm/fake-step";
import { createLlmClient, type LlmCatalog } from "@/server/llm/client";
import { createWebTools } from "@/server/llm/web-tools";

// The Draft stage for the dry run: the REAL Draft handler (Task 17: budget scopes, checkpoints, script contract, evidence
// check, fenced save) with a scripted model and an empty search engine, so no network and no key are involved. It still
// reserves and settles real (tiny) money through ctx.paid.

const FAKE_ROW: ModelRow = {
  id: "00000000-0000-4000-8000-00000000d0d0",
  provider: "anthropic",
  modelId: "dry-run",
  label: "Dry run model",
  baseUrl: null,
  prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 1_000_000 },
  isFree: false,
  capabilities: { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 },
  enabled: true,
  endpointKind: "hosted",
};
const CATALOG: LlmCatalog = { route: async () => FAKE_ROW, localServices: async () => [] };
const usage = { inputTokens: 100, outputTokens: 100 };

export function dryRunDraftHandler(db: pg.Pool): StageHandler {
  return async (ctx) => {
    const video = ctx.stage.videoId ? await loadDraftVideo(db, ctx.stage.videoId) : null;
    if (!video) throw new KnownFailure("The video for this draft no longer exists.");
    const script: StepResult[] = [
      { text: JSON.stringify({ queries: ["dry run"] }), toolCalls: [], usage },
      { text: JSON.stringify(fakeDraft(video.language)), toolCalls: [], usage },
    ];
    const step = fakeModelStep({ lang: video.language, script });
    const emptySearch = (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as never;
    return createDraftHandler({
      db,
      makeLlm: (scopes) => createLlmClient({ db, catalog: CATALOG, getKey: async () => null, buildModel: () => ({}) as LanguageModel, budgetScopes: () => scopes, makeStep: () => step }),
      makeWeb: () => createWebTools({ searxUrl: "http://127.0.0.1:1", fetchImpl: emptySearch }),
    })(ctx);
  };
}
