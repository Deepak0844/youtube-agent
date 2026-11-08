import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import type { NewVideoInput } from "@/server/core/videos-view";
import { approvalReaders } from "@/server/db/approval-readers";
import { recordAudit } from "@/server/db/audit";
import { lengthRangeProblem } from "@/server/core/long-form";
import { advanceVideo, createVideo, type EnqueueOnly } from "@/server/db/pipeline";
import { maxLongMinutes } from "@/server/db/system-settings";

/** Owner starts a new Short or Long video: row, audit, then the first pipeline step. The topic and notes stay out of the audit row. */
export async function startNewVideo(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, i: NewVideoInput): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  return startVideo(db, queue, actor.sessionId, i);
}

/** The same start for the overnight scheduler (sessionId null). Creates a draft only: no gate is approved, nothing is uploaded. */
export async function startVideo(db: pg.Pool, queue: EnqueueOnly, sessionId: string | null, i: NewVideoInput, channelId: string | null = null): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  // A long video (scene kit only) carries its length range, re-checked here against the live max-length setting whoever called.
  if (i.format === "long") {
    if (i.kind !== "scene_kit") return { ok: false, message: "Long videos use the Scene kit for now." };
    const problem = lengthRangeProblem(i.lengthMin, i.lengthMax, await maxLongMinutes(db));
    if (problem) return { ok: false, message: problem };
  }
  const v = await createVideo(db, { channelId, format: i.format, kind: i.kind, language: i.language, topic: i.topic, notes: i.notes ?? null, style: i.style ?? null, captionStyle: i.captionStyle ?? null, ...(i.format === "long" ? { lengthMinMinutes: i.lengthMin, lengthMaxMinutes: i.lengthMax } : {}) });
  await recordAudit(db, "video.created", { videoId: v.id, language: v.language, kind: v.kind, format: v.format, sessionId, ...(v.format === "long" ? { lengthMin: i.lengthMin, lengthMax: i.lengthMax } : {}) });
  try {
    await advanceVideo(db, queue, v.id, approvalReaders);
  } catch {
    /* best effort: the worker's sweep starts it */
  }
  return { ok: true, videoId: v.id };
}
