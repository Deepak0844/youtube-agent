import { KnownFailure } from "@/server/core/paid-call";
import { STAGE_NAMES, stagePlan, type StageName } from "@/server/core/pipeline-plan";
import { createSemaphore } from "@/server/core/semaphore";
import type { StageHandler } from "@/server/core/stage-handler";

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
