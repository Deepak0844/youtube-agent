import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { versionInput, type NewVideoInput } from "@/server/core/videos-view";
import { approvalReaders } from "@/server/db/approval-readers";
import { recordAudit } from "@/server/db/audit";
import { lengthRangeProblem, lengthVsQaProblem } from "@/server/core/long-form";
import { advanceVideo, createVideo, type EnqueueOnly } from "@/server/db/pipeline";
import { CharacterRefused, characterProblemOf, setVideoCharacter } from "@/server/db/video-characters";
import { maxLongMinutes, qaLongSeconds } from "@/server/db/system-settings";

/** Owner starts a new Short or Long video: row, audit, then the first pipeline step. The topic and notes stay out of the audit row. */
// `channelId` is optional ("choose later"); a given one must be a connected channel row.
export async function startNewVideo(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, i: NewVideoInput, channelId: string | null = null): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  if (channelId !== null && !(await db.query("select 1 from youtube_channels where channel_id = $1", [channelId])).rowCount) return { ok: false, message: "That channel is not connected." };
  return startVideo(db, queue, actor.sessionId, i, channelId);
}

/** The same start for the overnight scheduler (sessionId null). Creates a draft only: no gate is approved, nothing is uploaded. */
export async function startVideo(db: pg.Pool, queue: EnqueueOnly, sessionId: string | null, i: NewVideoInput, channelId: string | null = null): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  // A long video (scene kit only) carries its length range, re-checked here against the live max-length setting whoever called.
  if (i.format === "long") {
    if (i.kind !== "scene_kit") return { ok: false, message: "Long videos use the Scene kit for now." };
    const problem = lengthRangeProblem(i.lengthMin, i.lengthMax, await maxLongMinutes(db));
    if (problem) return { ok: false, message: problem };
    // Refuse now what the QA length check would block after Draft, voice and Render had been paid for.
    const qa = lengthVsQaProblem({ min: i.lengthMin!, max: i.lengthMax! }, await qaLongSeconds(db));
    if (qa) return { ok: false, message: qa };
  }
  // A locked character is checked BEFORE the video exists, so a bad picture never leaves a half-made video behind.
  if (i.characterAssetId && i.kind !== "ai") return { ok: false, message: "Only an AI video has a character picture." };
  if (i.characterAssetId) {
    const why = await characterProblemOf(db, i.characterAssetId);
    if (why) return { ok: false, message: why };
  }
  const v = await createVideo(db, { channelId, format: i.format, kind: i.kind, language: i.language, topic: i.topic, notes: i.notes ?? null, style: i.style ?? null, captionStyle: i.captionStyle ?? null, ...(i.format === "long" ? { lengthMinMinutes: i.lengthMin, lengthMaxMinutes: i.lengthMax } : {}) });
  await recordAudit(db, "video.created", { videoId: v.id, language: v.language, kind: v.kind, format: v.format, sessionId, ...(v.format === "long" ? { lengthMin: i.lengthMin, lengthMax: i.lengthMax } : {}) });
  if (i.characterAssetId) {
    try {
      await setVideoCharacter(db, v.id, i.characterAssetId);
    } catch (e) {
      if (!(e instanceof CharacterRefused)) throw e; // the picture changed in the meantime: the video starts without a character and the owner can set one
    }
  }
  try {
    await advanceVideo(db, queue, v.id, approvalReaders);
  } catch {
    /* best effort: the worker's sweep starts it */
  }
  return { ok: true, videoId: v.id };
}

/**
 * The owner remakes a Short as another video type on the same topic: a NEW video that starts from the topic, notes, language, channel and look of the
 * old one. Nothing is shared with the old video: no approval, spend or file is carried over, and the old video is not touched. Starts like any new video
 * (so the same caps and checks apply).
 */
export async function startVersion(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, sourceId: string, kind: unknown): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  let src: { topic: string; language: string; notes: string | null; style: string | null; caption_style: string | null; format: string; kind: string; channel_id: string | null } | undefined;
  try {
    src = (await db.query("select topic, language, notes, style, caption_style, format, kind, channel_id from videos where id = $1", [sourceId])).rows[0];
  } catch {
    src = undefined; // not a uuid
  }
  if (!src) return { ok: false, message: "That video was not found." };
  const input = versionInput({ topic: src.topic, language: src.language, notes: src.notes, style: src.style, captionStyle: src.caption_style, format: src.format, kind: src.kind }, kind);
  if (!input.ok) return input;
  const r = await startVideo(db, queue, actor.sessionId, input.value, src.channel_id);
  if (r.ok) await recordAudit(db, "video.version_made", { videoId: r.videoId, fromVideoId: sourceId, kind: input.value.kind, sessionId: actor.sessionId });
  return r;
}
