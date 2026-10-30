import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCostPlan } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import { ensureCapScope } from "@/server/db/budget-scopes";
import { approvedCostPlan, approvedScript } from "@/server/db/stage-content";
import { assertProviderName, type AttemptHandler } from "./attempt";
import { DEFAULTS, loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

/**
 * Generate: buys what the approved cost plan lists, one paid call per item, and nothing else.
 *
 * - The plan used is the exact version the owner approved (read through its approval), never "the newest".
 * - Before EVERY item the approval is read again. If the plan was edited (a provider or a price changed) the approval is void
 *   and the stage stops with a known failure; nothing more is bought. The pipeline then waits at the cost gate again.
 * - Every call also reserves against a scope whose cap is the approved quote. The reserve is the item's quoted price and the
 *   provider's real charge is settled; once reserved + spent reach the quote, the next call is refused (BudgetRefused ->
 *   needs_decision). A provider that charges more than it quoted therefore stops the run instead of silently overspending.
 * - Calls are numbered in order by ctx.paid, so a run resumed after a crash replays finished items from storage and never
 *   pays twice. The provider result carries the image bytes (fake provider only: real adapters will store a URL instead),
 *   because the replayed result must be able to rebuild the file in the new attempt folder.
 */
export function generateAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    const approved = await approvedCostPlan(deps.db, video.id);
    if (!approved.ok) throw new KnownFailure(approved.reason);
    const parsed = parseCostPlan(approved.body);
    if (!parsed.ok) throw new KnownFailure(parsed.reason);
    const { plan, quoteMicroUsd } = parsed;

    const wantProvider = deps.imageProvider ?? DEFAULTS.imageProvider;
    for (const item of plan.items) {
      if (item.kind !== "image") throw new KnownFailure("Only image items can be generated in the dry run.");
      if (item.provider !== wantProvider) throw new KnownFailure(`The approved plan names ${item.provider}, but ${wantProvider} is what is set up. Build the plan again.`);
    }

    const quoteScope = await ensureCapScope(deps.db, `quote:${video.id}:${approved.hash.slice(0, 16)}`, quoteMicroUsd);
    const scopes = [...(await videoMoneyScopes(deps.db, video)), quoteScope];
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const beats = script.beats;

    const files: string[] = [];
    for (const [index, item] of plan.items.entries()) {
      const still = await approvedCostPlan(deps.db, video.id);
      if (!still.ok || still.hash !== approved.hash) throw new KnownFailure("The cost plan changed while images were being made. Approve it again; nothing more was bought.");
      const beat = Array.isArray(beats) ? beats[index] : undefined;
      const prompt = typeof beat?.id === "string" ? `scene ${beat.id}` : `scene ${index + 1}`;
      const made = await ctx.paid<{ name: string; b64: string }>(
        { reserveMicroUsd: item.quoteMicroUsd, budgetScopes: scopes, kind: "paid" },
        async () => {
          const r = await deps.image.generate(ctx, { prompt, aspect: "9:16", model: wantProvider });
          const name = path.basename(r.path);
          return { result: { name, b64: (await readFile(r.path)).toString("base64") }, actualMicroUsd: r.provenance.priceMicroUsd };
        },
      );
      assertProviderName(made.name, "image");
      await writeFile(path.join(ctx.attemptDir, made.name), Buffer.from(made.b64, "base64")); // also rebuilds the file after a resume
      if (!files.includes(made.name)) files.push(made.name);
    }
    return { files, result: { images: files.length, quoteMicroUsd } };
  };
}
