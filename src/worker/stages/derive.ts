import { writeFile } from "node:fs/promises";
import path from "node:path";
import { clipBeats, clipNarration, clipScenes, clipWords, planClip, type Word } from "@/server/core/derive-short";
import { KnownFailure } from "@/server/core/paid-call";
import { approvedScript } from "@/server/db/stage-content";
import { latestContent } from "@/server/db/videos";
import { cutNarration, durationS } from "@/server/render/mix";
import { validateScenes } from "@/shared/scene";
import { retimeScenes } from "@/shared/scene/retime";
import { promotedPath, sha256File, type AttemptHandler } from "./attempt";
import { loadVideo, type StageDeps } from "./deps";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A short cut out of a long video (Phase 6b.4). Free and local: no model, no voice. It takes a run of consecutive scenes of the long video and
 * writes everything a short needs after Draft, Build and Narration: the script (the clip's narration text), its beats and evidence, the scenes
 * (starts shifted to 0), the narration (cut from the long narration with ffmpeg) and the caption words (shifted). The owner then approves the
 * script as for any short, and Render, Voice, Sound and QA run as usual.
 *
 * The long video's stored scenes still carry Build's rough timing (Render re-times them at render time and keeps nothing), so the same re-timing is
 * done here first; a re-time that fails stops the stage instead of cutting at guessed times.
 */
export function deriveAttempt(deps: StageDeps): AttemptHandler {
  return async (ctx) => {
    if (!deps.mix) throw new KnownFailure("No video tool is wired, so the clip cannot be cut.");
    const video = await loadVideo(deps.db, ctx);
    const own = (await deps.db.query<{ topic: string; derived_from: string | null; derive_from_scene: number | null; derive_to_scene: number | null }>("select topic, derived_from, derive_from_scene, derive_to_scene from videos where id = $1", [video.id])).rows[0];
    if (!own || own.derive_from_scene === null || own.derive_to_scene === null) throw new KnownFailure("This video is not a short derived from a long video.");
    if (video.format !== "short" || video.kind !== "scene_kit") throw new KnownFailure("Only a scene-kit short can be derived from a long video.");
    if (!own.derived_from) throw new KnownFailure("The long video this short was cut from no longer exists.");
    const srcId = own.derived_from;
    const src = (await deps.db.query<{ format: string }>("select format from videos where id = $1", [srcId])).rows[0];
    if (!src || src.format !== "long") throw new KnownFailure("The long video this short was cut from no longer exists.");

    // The long video's approved script and finished content.
    const script = await approvedScript(deps.db, srcId);
    if (!script.ok) throw new KnownFailure(`The long video's script: ${script.reason}`);
    const scenesBody = (await latestContent(deps.db, srcId, "scenes"))?.body;
    const v = validateScenes(scenesBody, { long: true });
    if (!v.ok) throw new KnownFailure("The long video has no valid scenes yet. Let it finish building first.");
    const captions = (await latestContent(deps.db, srcId, "captions"))?.body;
    const words = isObj(captions) && Array.isArray(captions.words) ? (captions.words as Word[]).filter((w) => typeof w?.word === "string" && Number.isFinite(w.startS) && Number.isFinite(w.endS)) : [];
    const narration = (await latestContent(deps.db, srcId, "narration"))?.body;
    const narrationFile = isObj(narration) && typeof narration.file === "string" ? narration.file : null;
    if (words.length === 0 || narrationFile === null) throw new KnownFailure("The long video has no narration or caption times yet. Let it finish narrating first.");
    const audio = await promotedPath(deps.root, srcId, narrationFile);

    // Real times: the same re-timing Render does, strict here.
    const beatsText = script.beats.map((b, i) => ({ id: typeof b?.id === "string" && b.id !== "" ? b.id : `beat-${i + 1}`, text: typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "" }));
    // ffprobe, not audioSeconds: that reads the whole file into memory, and a long video's narration can be hundreds of MB.
    const narrationS = await durationS(deps.mix, ctx, audio).catch(() => Math.max(...words.map((w) => w.endS)) + 0.3);
    const timed = retimeScenes(v.doc, { words, beats: beatsText, narrationDurationS: narrationS, long: true });
    if (!timed.ok) throw new KnownFailure(`retime_failed: ${timed.errors.slice(0, 2).join("; ")}. The long video's scenes could not be fitted to its narration.`.slice(0, 600));

    const plan = planClip(timed.doc.scenes, { from: own.derive_from_scene, to: own.derive_to_scene });
    if (!plan.ok) throw new KnownFailure(plan.reason);
    const w = plan.window;
    const shortDoc = { version: 1, scenes: clipScenes(timed.doc.scenes, w) };
    const ok = validateScenes(shortDoc);
    if (!ok.ok) throw new KnownFailure(`The clip is not a valid short: ${ok.errors.slice(0, 2).join("; ")}`.slice(0, 600));

    const beats = clipBeats(script.beats as Array<{ id?: unknown; est_start?: unknown; est_end?: unknown }>, shortDoc.scenes).map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => k !== "est_start" && k !== "est_end"))); // the long video's time estimates mean nothing here
    const text = clipNarration(beats as Array<{ text?: unknown }>);
    if (text === "") throw new KnownFailure("The clip has no narration text.");
    const evidence = (await latestContent(deps.db, srcId, "evidence"))?.body;
    const claims = isObj(evidence) && Array.isArray(evidence.claims) ? evidence.claims : [];

    const out = path.join(ctx.attemptDir, "narration.wav");
    await cutNarration(deps.mix, ctx, { narration: audio, out, window: w });
    await writeFile(path.join(ctx.attemptDir, "scenes.json"), JSON.stringify(shortDoc));

    const srcNarration = narration as Record<string, unknown>;
    return {
      files: ["scenes.json", "narration.wav"],
      content: [
        { kind: "script", body: { title: own.topic, narration: text } },
        { kind: "beats", body: { beats } },
        { kind: "evidence", body: { claims } },
        { kind: "scenes", body: shortDoc },
        { kind: "narration", body: { ...srcNarration, file: "narration.wav", audio_sha256: await sha256File(out), derived_from: srcId } },
        { kind: "captions", body: { ...(captions as Record<string, unknown>), words: clipWords(words, w) } },
      ],
      result: { derivedFrom: srcId, fromScene: w.from, toScene: w.to, startMs: w.startMs, durationMs: w.durationMs, scenes: shortDoc.scenes.length },
    };
  };
}
