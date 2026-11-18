import { mkdir } from "node:fs/promises";
import path from "node:path";
import { montageSlots, type MontageBeat } from "@/server/core/montage-slots";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { tsxCaptionWords } from "@/server/core/tsx-captions";
import { getAsset } from "@/server/db/assets";
import { approvedScript } from "@/server/db/stage-content";
import { assetsForVideo } from "@/server/db/video-assets";
import { renderClip, type ClipRenderInput, type ClipRenderResult } from "@/server/providers/renderer/clip-render";
import { montageFile } from "@/server/render/mix";
import { safeJoin } from "@/server/storage/paths";
import { copyRegular } from "@/server/storage/regular-file";
import type { AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";
import { loadTsxInputs } from "./tsx-author";

export interface MontageOverrides {
  /** Test seam. Default: renderClip through the locked renderer (deps.tsxDeps). */
  render?: (ctx: StageContext, input: ClipRenderInput) => Promise<ClipRenderResult>;
}

const FADE_S = 0.2;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Montage (M3): after narration and the footage step (the pictures step, clips only). One footage clip per slot (a slot = a beat, as long as it is spoken),
 * each used once, trimmed from its middle, cover-fitted to 1080x1920, one colour grade, a dip at each seam (ffmpeg, core/montage-edit.ts). The app's captions
 * go on in the locked renderer (as for a clip). The film's length is the narration's. Voice, sound and QA then run as for any Short. Free and local.
 * A beat with no footage, a clip shorter than its slot, or one clip on two beats fails the step with a plain sentence naming the beat: a short or repeating film is never made.
 */
export function montageAttempt(deps: StageDeps, o: MontageOverrides = {}): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "montage") throw new KnownFailure("This video is not a montage.");
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so the footage cannot be edited.");
    const tsxDeps = deps.tsxDeps;
    const render = o.render ?? (tsxDeps ? (c: StageContext, i: ClipRenderInput) => renderClip(tsxDeps, c, i) : undefined);
    if (!render) throw new KnownFailure("The locked renderer is not set up on this worker, so captions cannot be drawn.");

    const { beats, words, narrationS } = await loadTsxInputs(deps, ctx, video.id);
    const script = await approvedScript(deps.db, video.id);
    if (!script.ok) throw new KnownFailure(script.reason);
    const searchOf = new Map(script.beats.map((b) => [String((b as { id?: unknown }).id), (b as { search?: unknown }).search]));
    const montageBeats: MontageBeat[] = beats.map((b) => {
      const s = searchOf.get(b.id);
      return { ...b, ...(Array.isArray(s) ? { search: s.filter((x): x is string => typeof x === "string") } : {}) };
    });
    const slots = montageSlots(montageBeats, words, narrationS);
    if (slots.length === 0) throw new KnownFailure("The script has no beats to find footage for.");

    const links = await assetsForVideo(deps.db, video.id);
    const missing: string[] = [];
    const used = new Set<string>();
    const picks: { slotId: string; assetId: string; seconds: number; credit: string | null }[] = [];
    const clips: { file: string; durationS: number; slotS: number }[] = [];
    await mkdir(ctx.attemptDir, { recursive: true });
    for (const [i, slot] of slots.entries()) {
      const link = links.find((l) => l.beatId === slot.id && l.kind === "video");
      if (!link) { missing.push(slot.id); continue; }
      if (used.has(link.assetId)) throw new KnownFailure(`The same clip is on two beats (${slot.id} repeats an earlier one). Run the footage step again with different search words.`);
      const asset = await getAsset(deps.db, link.assetId);
      if (!asset || asset.deletedAt) { missing.push(slot.id); continue; }
      if (!(asset.durationS !== null && asset.durationS >= slot.seconds)) throw new KnownFailure(`The clip for beat ${slot.id} is ${asset.durationS?.toFixed(1) ?? "an unknown number of"} s but the beat needs ${slot.seconds.toFixed(1)} s. Run the footage step again.`);
      used.add(link.assetId);
      const file = `m${pad(i + 1)}.mp4`;
      await copyRegular(await safeJoin(deps.root, asset.storageRef), path.join(ctx.attemptDir, file));
      clips.push({ file, durationS: asset.durationS, slotS: slot.seconds });
      picks.push({ slotId: slot.id, assetId: link.assetId, seconds: slot.seconds, credit: link.credit ?? null });
    }
    if (missing.length > 0) throw new KnownFailure(`No footage was found for beat${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. Send the script back with clearer pictures to show, or run the footage step again.`);

    const filmS = await montageFile(deps.mix, ctx, { clips, grade: "film", width: 1080, height: 1920, fadeS: FADE_S, out: path.join(ctx.attemptDir, "film.mp4") });
    const done = await render(ctx, { clipFile: path.join(ctx.attemptDir, "film.mp4"), captions: tsxCaptionWords(words), style: video.style, durationS: filmS, outFile: "render.mp4" });
    if (!done.ok) throw new KnownFailure(`The captions did not render: ${done.message}`);
    ctx.log(`montage: ${clips.length} clips, ${filmS.toFixed(1)} s`);
    return {
      files: ["render.mp4"],
      content: [{ kind: "footage", body: { picks } }],
      result: { rendered: "render.mp4", clips: clips.length, durationS: Math.round(filmS * 100) / 100 },
    };
  };
}
