import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { chapterFingerprint, chapterSoundCues, chapterWindows } from "@/server/core/chapter-windows";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { engineModelFor } from "@/server/core/engine-config";
import { reviewRecord } from "@/server/core/frame-review";
import { KnownFailure } from "@/server/core/paid-call";
import { checkTsx, tsxDuration } from "@/server/core/tsx-check";
import { tsxCaptionWords } from "@/server/core/tsx-captions";
import { approvedOutline } from "@/server/db/stage-content";
import { chapterBuildRequest } from "@/server/engine/build-prompt";
import { EngineLimitError } from "@/server/engine/limit";
import { runEngine } from "@/server/engine/run";
import { buildEngineTools } from "@/server/engine/tools-factory";
import { joinClips } from "@/server/render/mix";
import { addContent } from "@/server/db/videos";
import type { AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";
import { engineCues, readSceneFile, type EngineBuildDeps } from "./engine-build";
import { loadTsxInputs } from "./tsx-author";

// Long videos, L3: the code-scene step of a long video. The narration of the WHOLE script is recorded first, so every chapter knows its seconds and its
// exact frames (core/chapter-windows.ts). Then one engine run draws each chapter into its own file (scene/ch01.tsx ...), chapter 1 first and its file is
// given to the later chapters as the look to match. Each finished chapter is saved AT ONCE (content kind chapter_scene, with the fingerprint it was made
// from), so a failed or cut-off step redraws only the chapter that is missing. Every chapter is rendered in the locked renderer with its captions and the
// chapter videos are joined into render.mp4, which voice, sound and QA take as for a Short. Long videos are landscape. Nothing here spends money: the
// engine runs on the owner's subscription, and the usage limit pauses the step (EngineLimitError).

const CUES = "sfx-cues.json";
const SEAM_FADE_S = 0.2; // each side of a chapter seam
const MAX_CHAPTERS = 6;

interface SavedChapter {
  index: number;
  fingerprint: string;
  source: string;
  /** the chapter's own sound cues on its own clock; absent for a chapter drawn before cues existed */
  cues: Cue[];
}
type Cue = { id: string; sound: string; atS: number; gainDb: number; optional: boolean };

/** The newest saved file of every chapter of this video. */
async function savedChapters(db: pg.Pool, videoId: string): Promise<Map<number, SavedChapter>> {
  const r = await db.query<{ body: { index?: unknown; fingerprint?: unknown; source?: unknown; cues?: unknown } }>(
    "select distinct on ((body->>'index')) body from video_content where video_id = $1 and kind = 'chapter_scene' order by (body->>'index'), version desc",
    [videoId],
  );
  const out = new Map<number, SavedChapter>();
  for (const { body } of r.rows) if (Number.isInteger(body.index) && typeof body.fingerprint === "string" && typeof body.source === "string") out.set(body.index as number, { index: body.index as number, fingerprint: body.fingerprint, source: body.source, cues: Array.isArray(body.cues) ? (body.cues as Cue[]) : [] });
  return out;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function longEngineBuildAttempt(deps: StageDeps, e: EngineBuildDeps): AttemptHandler {
  return async (ctx) => {
    const video = await loadVideo(deps.db, ctx);
    if (video.kind !== "tsx" || video.format !== "long") throw new KnownFailure("This video is not a long code-scene video.");
    if (!deps.tsx) throw new KnownFailure("Code scenes are not set up on this worker.");
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so the chapters cannot be joined.");
    const orientation = "landscape" as const; // a long video is 16:9
    const { beats, words, narrationS, topic } = await loadTsxInputs(deps, ctx, video.id, e.narrationSeconds, { long: true });
    const outline = await approvedOutline(deps.db, video.id);
    if (!outline.ok) throw new KnownFailure(outline.reason);
    const cw = chapterWindows({ outline: outline.outline, beats, words, narrationS });
    if (!cw.ok) throw new KnownFailure(cw.reason);
    // The QA check fails a long video outside its length range, and a real run found that out only AFTER all five chapters were drawn. Check it first.
    const qa = ctx.config.qa.long;
    const videoS = cw.totalFrames / 30;
    const tol = ctx.config.qa.durationToleranceS;
    if (videoS < qa.minS - tol) {
      const extra = Math.ceil((qa.minS * 1.03 - videoS) * (words.length / narrationS));
      throw new KnownFailure(`The narration is ${videoS.toFixed(0)} s, but a long video must run at least ${qa.minS} s (the QA setting "QA long: shortest"). Nothing was drawn. Send the script back and ask for about ${extra} more words, or lower that setting, then run the narration again.`);
    }
    if (videoS > qa.maxS + tol) throw new KnownFailure(`The narration is ${videoS.toFixed(0)} s, but a long video may run at most ${qa.maxS} s (the QA setting "QA long: longest"). Nothing was drawn. Shorten the script or raise that setting, then run the narration again.`);
    if (cw.chapters.length > MAX_CHAPTERS) throw new KnownFailure(`The outline has ${cw.chapters.length} chapters; a code-scene video has at most ${MAX_CHAPTERS}.`);

    const saved = await savedChapters(deps.db, video.id);
    const total = cw.chapters.length;
    const clips: string[] = [];
    let lookSource: string | undefined;
    const ownCues = new Map<number, Cue[]>();
    let turns = 0;
    let drawn = 0;
    let stills: string[] = [];
    let image = "";
    for (const c of cw.chapters) {
      const fp = chapterFingerprint(c, { style: video.style, orientation });
      const have = saved.get(c.index);
      let source = have?.fingerprint === fp ? have.source : undefined;
      if (source === undefined) {
        const { prompt, inputs, file } = chapterBuildRequest({ topic, chapter: c, total, style: video.style, orientation, ...(lookSource ? { lookSource } : {}) });
        const r = await (e.runEngine ?? runEngine)(
          {
            db: deps.db, root: e.root, config: ctx.config.engine, registry: e.registry,
            tools: (ws) => buildEngineTools({ db: deps.db, ctx, workDir: ws.workDir, orientation, storageRoot: deps.root, render: e.render, style: video.style }),
          },
          { videoId: video.id, stageRunId: ctx.claim.stageRunId, kind: "build", prompt, inputs, long: false, signal: ctx.signal, model: engineModelFor(ctx.config, video.style) },
        );
        if (!r.ok) {
          if (r.limit) throw new EngineLimitError(r.resumeAt); // chapters before this one are already saved
          throw new KnownFailure(`Chapter ${c.index} of ${total}: ${r.message}`);
        }
        const fresh = await readSceneFile(r.workDir, file);
        const checked = checkTsx(fresh, orientation);
        if (!checked.ok) throw new KnownFailure(`Chapter ${c.index} of ${total}: the scene file did not pass the safety check: ${checked.problems.slice(0, 3).join(" ")}`);
        const frames = tsxDuration(fresh);
        if (frames !== c.frames) throw new KnownFailure(`Chapter ${c.index} of ${total}: the scene file is ${frames ?? "an unknown number of"} frames; meta.durationInFrames must be ${c.frames} (this chapter's share of the narration). Run the step again.`);
        const chapterCues = (await engineCues(r.workDir, frames / 30)).cues; // sound is never a reason to fail: none or a bad file = no cues
        const body = { index: c.index, fingerprint: fp, source: fresh, frames, cues: chapterCues, engine: { turns: r.turns } };
        await addContent(deps.db, video.id, "chapter_scene", { body, sha256: sha256Hex(canonicalJson(body)) }); // saved at once: a later failure keeps this chapter
        source = fresh;
        ownCues.set(c.index, chapterCues);
        turns += r.turns;
        drawn++;
        ctx.log(`engine: chapter ${c.index} of ${total} drawn in ${r.turns} turns`);
      } else {
        ownCues.set(c.index, have?.cues ?? []);
        ctx.log(`engine: chapter ${c.index} of ${total} kept from an earlier run`);
      }
      if (c.index === 1) lookSource = source;

      const name = `ch${pad(c.index)}`;
      const rendered = await deps.tsx.renderTsx(ctx, { source, captions: tsxCaptionWords(c.words), style: video.style, orientation, outFile: `${name}.mp4` });
      if (!rendered.ok) throw new KnownFailure(`Chapter ${c.index} of ${total} did not render: ${[rendered.error.message, ...rendered.error.problems.slice(0, 3)].join(" ")}`);
      // Every chapter's render writes its preview frames under the same names. The video page shows chapter 1's, so they are set aside now and put back
      // after the loop; the later chapters' frames are deleted.
      if (c.index === 1) {
        stills = rendered.stills;
        image = rendered.image;
        for (const s of stills) await rename(path.join(ctx.attemptDir, s), path.join(ctx.attemptDir, `ch01-${s}`));
      } else {
        for (const s of rendered.stills) await rm(path.join(ctx.attemptDir, s), { force: true });
      }
      clips.push(`${name}.mp4`);
    }

    for (const s of stills) await rename(path.join(ctx.attemptDir, `ch01-${s}`), path.join(ctx.attemptDir, s));
    const joinedS = await joinClips(deps.mix, ctx, { clips, out: path.join(ctx.attemptDir, "render.mp4"), fade: { lengthsS: cw.chapters.map((c) => c.frames / 30), fadeS: SEAM_FADE_S } });
    for (const f of clips) await rm(path.join(ctx.attemptDir, f), { force: true });
    const wantS = cw.totalFrames / 30;
    if (Math.abs(joinedS - wantS) > 1) throw new KnownFailure(`The joined video is ${joinedS.toFixed(1)} s but the narration needs ${wantS.toFixed(1)} s. Run the step again.`);
    await writeFile(path.join(ctx.attemptDir, CUES), JSON.stringify(chapterSoundCues(cw.chapters, ownCues, wantS))); // a soft whoosh at each seam plus each chapter's own cues moved to the video's clock
    const review = reviewRecord({ status: "skipped", reason: "frame review skipped: the engine looked at its own previews" }, 1);
    const chaptersBody = cw.chapters.map((c) => ({ index: c.index, title: c.title, frames: c.frames }));
    return {
      files: ["render.mp4", ...stills, CUES],
      content: [
        { kind: "tsx", body: { chapters: chaptersBody, durationInFrames: cw.totalFrames, orientation, attempts: 1, image, stills, engine: { turns } } },
        { kind: "frame_review", body: review },
      ],
      result: { rendered: "render.mp4", chapters: total, drawnNow: drawn, keptFromBefore: total - drawn, durationInFrames: cw.totalFrames, image, frameReview: review, engine: { turns } },
    };
  };
}
