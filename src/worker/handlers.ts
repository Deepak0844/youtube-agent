import type pg from "pg";
import { createDraftHandler } from "@/server/authoring/draft";
import { KnownFailure } from "@/server/core/paid-call";
import { STAGE_NAMES, stagePlan, type StageName } from "@/server/core/pipeline-plan";
import { createSemaphore } from "@/server/core/semaphore";
import type { StageHandler } from "@/server/core/stage-handler";
import { loadKeyring } from "@/server/db/master-key";
import { createLlmClient } from "@/server/llm/client";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { createWebTools } from "@/server/llm/web-tools";
import { createFakeImage } from "@/server/providers/media/fake";
import { createFakeRenderer } from "@/server/providers/renderer/fake";
import { createFakeVoice } from "@/server/providers/voice/fake";
import { storageRoot } from "@/server/storage/paths";
import { withAttempt } from "./stages/attempt";
import { buildAttempt } from "./stages/build";
import type { StageDeps } from "./stages/deps";
import { dryRunDraftHandler } from "./stages/draft";
import { generateAttempt } from "./stages/generate";
import { qaAttempt } from "./stages/qa";
import { renderAttempt } from "./stages/render";
import { sfxAttempt } from "./stages/sfx";
import { ttsAttempt } from "./stages/tts";
import { voiceAttempt } from "./stages/voice";

// Tasks 15/20 supply concrete handlers. There is deliberately no fake production fallback.
export type StageHandlers = Partial<Record<StageName, StageHandler>>;
export function createStageDispatcher(handlers: StageHandlers, concurrentRenders: number): StageHandler {
  const render = createSemaphore(concurrentRenders);
  const resources = new Map(stagePlan("scene_kit", "short", { paidGeneration: true, requireEvidence: true }).map((s) => [s.stage, s.resource]));
  return async (ctx) => {
    const name = ctx.stage.name;
    if (!(STAGE_NAMES as readonly string[]).includes(name)) throw new KnownFailure("unknown stage");
    const handler = Object.hasOwn(handlers, name) ? handlers[name as StageName] : undefined;
    if (!handler) throw new KnownFailure(`missing stage handler: ${name}`);
    const run = async () => {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      return handler(ctx);
    };
    return resources.get(name as StageName) === "render" ? render.run(run) : run();
  };
}

/** Fake providers on the real storage root: what the dry run (and its tests) wire in. Never used by the production worker. */
export function defaultDryRunDeps(pool: pg.Pool, root: string = storageRoot()): StageDeps {
  return { db: pool, root, voice: createFakeVoice(), image: createFakeImage(), renderer: createFakeRenderer() };
}

/**
 * Every stage on fake providers (Task 20). Draft is the real Draft handler on a scripted model; the other seven write
 * only into their attempt folder and return file names, and `withAttempt` promotes them (fenced) before the stage commits.
 * Deliberately separate from productionHandlers: there is no fake fallback in production.
 */
export function dryRunHandlers(deps: StageDeps): StageHandlers {
  const fin = { db: deps.db, root: deps.root };
  return {
    draft: dryRunDraftHandler(deps.db),
    build: withAttempt(fin, buildAttempt(deps)),
    generate: withAttempt(fin, generateAttempt(deps)),
    tts: withAttempt(fin, ttsAttempt(deps)),
    render: withAttempt(fin, renderAttempt(deps)),
    voice: withAttempt(fin, voiceAttempt(deps)),
    sfx: withAttempt(fin, sfxAttempt(deps)),
    qa: withAttempt(fin, qaAttempt(deps)),
  };
}

/** The handlers the real worker runs. Draft uses the routed model and the owner's SearXNG; the other stages arrive with Task 20. */
export function productionHandlers(pool: pg.Pool): StageHandlers {
  const draft: StageHandler = async (ctx) => {
    const searxUrl = process.env.SEARXNG_URL;
    if (!searxUrl) throw new KnownFailure("Web search is not set up (SEARXNG_URL), so a draft cannot be written.");
    const models = await defaultModelDeps(pool, () => loadKeyring());
    return createDraftHandler({
      db: pool,
      makeLlm: (scopes) => createLlmClient({ db: pool, ...models, budgetScopes: () => scopes }),
      makeWeb: () => createWebTools({ searxUrl }),
    })(ctx);
  };
  return { draft };
}
