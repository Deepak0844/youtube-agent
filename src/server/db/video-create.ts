import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import type { NewVideoInput } from "@/server/core/videos-view";
import { approvalReaders } from "@/server/db/approval-readers";
import { recordAudit } from "@/server/db/audit";
import { advanceVideo, createVideo, type EnqueueOnly } from "@/server/db/pipeline";

/** Owner starts a new Short: row, audit, then the first pipeline step. The topic and notes stay out of the audit row. */
export async function startNewVideo(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, i: NewVideoInput): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const v = await createVideo(db, { format: i.format, kind: i.kind, language: i.language, topic: i.topic, notes: i.notes ?? null });
  await recordAudit(db, "video.created", { videoId: v.id, language: v.language, kind: v.kind, format: v.format, sessionId: actor.sessionId });
  try {
    await advanceVideo(db, queue, v.id, approvalReaders);
  } catch {
    /* best effort: the worker's sweep starts it */
  }
  return { ok: true, videoId: v.id };
}
