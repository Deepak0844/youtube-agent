import { copyFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { generatedRightsText } from "@/server/core/asset-rules";
import { splitClipProvider } from "@/server/core/ai-shots";
import { parseCostPlan } from "@/server/core/cost-plan";
import { KnownFailure } from "@/server/core/paid-call";
import { ensureCapScope } from "@/server/db/budget-scopes";
import { registerAsset } from "@/server/db/assets";
import { resolveRoute } from "@/server/db/media-registry";
import { approvedCostPlan } from "@/server/db/stage-content";
import { linkAsset, LinkRefused, unlinkStageBeats } from "@/server/db/video-assets";
import { ingestClip } from "@/server/render/ingest";
import { MAX_CLIP_BYTES } from "@/server/providers/video";
import type { AttemptHandler } from "./attempt";
import { loadVideo, videoMoneyScopes, type StageDeps } from "./deps";

const LABEL: Record<string, "Seedance" | "Kling" | "Veo"> = { seedance_video: "Seedance", kling_video: "Kling", veo_video: "Veo" };
const isShot = (s: unknown): s is { beatId: string; prompt: string; seconds: number } =>
  typeof s === "object" && s !== null && typeof (s as { beatId?: unknown }).beatId === "string" && typeof (s as { prompt?: unknown }).prompt === "string" && Number.isInteger((s as { seconds?: unknown }).seconds);

/**
 * Generate (AI videos): buys the clips of the approved cost plan, one paid call per shot, and nothing else.
 *
 * - The plan used is the exact version the owner approved. Before EVERY clip the approval is read again; if the plan changed, nothing more is bought.
 * - The routed provider and model must still be the ones the plan names, and each clip's price must still equal the approved price; otherwise it stops
 *   with a plain sentence BEFORE any money moves.
 * - Every call reserves against a scope whose cap is the approved quote, so a provider that charges more than it quoted stops the run.
 * - Calls are numbered in order by ctx.paid (and each adapter stores its job id first), so a run resumed after a crash replays finished clips from
 *   storage and never pays twice. Each clip then goes through the same sandboxed check as a stock clip, becomes a library asset (marked as AI-made)
 *   and is linked to its beat, where Build lays it out as a scene.
 */
export function generateClipsAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "ai") throw new KnownFailure("Only an AI video makes clips.");
    if (!deps.videoFor) throw new KnownFailure("AI video is not set up in this app yet.");
    if (!deps.ingest) throw new KnownFailure("Clip checking is not set up in this app yet.");
    const approved = await approvedCostPlan(deps.db, video.id);
    if (!approved.ok) throw new KnownFailure(approved.reason);
    const parsed = parseCostPlan(approved.body);
    if (!parsed.ok) throw new KnownFailure(parsed.reason);
    const { plan, quoteMicroUsd } = parsed;
    const shots = (approved.body as { shots?: unknown }).shots;
    if (!Array.isArray(shots) || shots.length !== plan.items.length || !shots.every(isShot)) throw new KnownFailure("The approved plan has no usable shot list. Plan the clips again.");
    if (plan.items.length === 0) throw new KnownFailure("The approved plan has no clips.");

    const target = splitClipProvider(plan.items[0]!.provider);
    if (!target || plan.items.some((i) => i.kind !== "clip" || i.provider !== plan.items[0]!.provider)) throw new KnownFailure("The approved plan does not name one clip model. Plan the clips again.");
    const route = await resolveRoute(deps.db, "video", { format: video.format, videoKind: video.kind });
    if (route?.provider !== target.providerId || route.model !== target.model) throw new KnownFailure(`The approved plan names ${plan.items[0]!.provider}, but a different video model is set up now. Plan the clips again.`);
    const provider = await deps.videoFor(target.providerId); // refuses (nothing reserved) when off, unpriced or without a key
    const quoteOf = (i: number) => provider.quote({ prompt: shots[i]!.prompt, seconds: shots[i]!.seconds, aspect: "9:16", startImage: false, endImage: false, model: target.model, budgetScopes: ["quote"] });
    for (const i of plan.items.keys()) {
      if (quoteOf(i) !== plan.items[i]!.quoteMicroUsd) throw new KnownFailure("A clip's price changed after you approved the plan. Plan the clips again; nothing was bought.");
    }

    const quoteScope = await ensureCapScope(deps.db, `quote:${video.id}:${approved.hash.slice(0, 16)}`, quoteMicroUsd);
    const scopes = [...(await videoMoneyScopes(deps.db, video)), quoteScope];
    const label = LABEL[target.providerId] ?? "Seedance";
    const made: Array<{ beatId: string; assetId: string; seconds: number; priceMicroUsd: number }> = [];
    for (const [i, shot] of shots.entries()) {
      const still = await approvedCostPlan(deps.db, video.id);
      if (!still.ok || still.hash !== approved.hash) throw new KnownFailure("The cost plan changed while clips were being made. Approve it again; nothing more was bought.");
      // The adapter reserves inside generate(), against the quote-cap scope passed here, and stores its job id before the clip is requested again.
      const art = await provider.generate(ctx, { prompt: shot.prompt, seconds: shot.seconds, aspect: "9:16", startImage: false, endImage: false, model: target.model, budgetScopes: scopes });

      // The paid file stays where the adapter stored it (a replay finds it); a copy goes through the sandboxed check and becomes the asset.
      const incoming = path.join(deps.root, "assets-incoming", `clip-${randomUUID()}`);
      const rel = `assets/${randomUUID()}`;
      const dest = path.join(deps.root, rel);
      let stored = false;
      try {
        await mkdir(path.dirname(incoming), { recursive: true });
        await mkdir(dest, { recursive: true });
        await copyFile(art.path, incoming);
        const r = await (deps.ingestClipFn ?? ingestClip)(deps.ingest, { srcPath: incoming, destDir: dest, maxBytes: MAX_CLIP_BYTES, signal: ctx.signal, stageRunId: ctx.claim.stageRunId });
        if (!r.ok) throw new Error(`A paid clip failed the safety check (${r.reason}); it was not requested again, and this needs the owner's decision.`); // paid: a plain error parks, never a refund
        const refs = Object.fromEntries(Object.entries(r.files).map(([role, f]) => [role, `${rel}/${path.basename(f)}`]));
        const { main, ...derivedRefs } = refs;
        // registerAsset merges into an existing asset with the same bytes (and revives it): the clip was paid for, so it is never dropped.
        const reg = await registerAsset(deps.db, {
          kind: "video", originalName: `${label}-${shot.beatId}.mp4`.replace(/[^A-Za-z0-9._ -]/g, "_"), mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, durationS: r.durationS,
          sha256: r.sha256, storageRef: main!, derivedRefs, tags: ["ai", "clip", label.toLowerCase()], caption: shot.prompt.slice(0, 500), source: "generated",
          rights: { attestations: [{ at: new Date().toISOString(), by: "system", text: generatedRightsText(label) }] }, containsPerson: false,
        });
        stored = !reg.duplicate;
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted"); // no link once the stage is cancelled
        await unlinkStageBeats(deps.db, video.id, [shot.beatId]); // a re-run replaces this beat's earlier clip
        try {
          await linkAsset(deps.db, { videoId: video.id, assetId: reg.asset.id, beatId: shot.beatId, credit: label, licence: "AI-generated", briefHash: `ai:${art.sha256.slice(0, 16)}` });
        } catch (e) {
          if (e instanceof LinkRefused) throw new Error(`A paid clip could not be linked to its beat (${e.message}); it is saved in the library, and this needs the owner's decision.`);
          throw e;
        }
        made.push({ beatId: shot.beatId, assetId: reg.asset.id, seconds: shot.seconds, priceMicroUsd: art.provenance.priceMicroUsd });
      } finally {
        if (!stored) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
        await rm(incoming, { force: true }).catch(() => undefined);
      }
      ctx.progress?.(Math.round(((i + 1) / shots.length) * 100));
    }
    return { files: [], content: [{ kind: "clips", body: { items: made } }], result: { clips: made.length, quoteMicroUsd, provider: target.providerId, model: target.model } };
  };
}
