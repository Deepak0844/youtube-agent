import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { findSimilar, type IdeaInput } from "@/server/core/ideas";
import { newVideoSchema } from "@/server/core/videos-view";
import { recordAudit } from "@/server/db/audit";
import type { EnqueueOnly } from "@/server/db/pipeline";
import { startVideo } from "@/server/db/video-create";

// The idea backlog. Text is untrusted and was cleaned by parseIdeaForm; every query is parameterised.
// Draft now only starts a normal video (startNewVideo). Nothing here approves or uploads.

export interface IdeaRow {
  id: string;
  topic: string;
  hook: string;
  why: string;
  sources: string[];
  score: number;
  status: string;
  videoId: string | null;
}

type Result = { ok: true } | { ok: false; message: string };

export async function listIdeas(db: pg.Pool): Promise<IdeaRow[]> {
  const { rows } = await db.query<Omit<IdeaRow, "videoId" | "score"> & { video_id: string | null; score: string }>(
    "select id, topic, hook, why, sources, score, status, video_id from ideas where status <> 'dismissed' order by (status = 'proposed') desc, score desc, created_at",
  );
  return rows.map(({ video_id, score, ...r }) => ({ ...r, score: Number(score), videoId: video_id }));
}

/** Rejects a topic that is too like any idea ever held (dismissed ones too, as the old app did) or any video topic. */
export async function addIdea(db: pg.Pool, actor: GateActor, i: IdeaInput): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const { rows: known } = await db.query<{ topic: string }>("select topic from ideas union all select topic from videos");
  const dup = findSimilar(i.topic, known.map((k) => k.topic));
  if (dup) return { ok: false, message: `Too like a topic you already have: "${dup.slice(0, 80)}".` };
  const { rows } = await db.query<{ id: string }>(
    "insert into ideas (topic, hook, why, sources, score) values ($1, $2, $3, $4::jsonb, $5) returning id",
    [i.topic, i.hook, i.why, JSON.stringify(i.sources), i.score],
  );
  const id = rows[0]!.id;
  await recordAudit(db, "idea.added", { ideaId: id, sources: i.sources.length, sessionId: actor.sessionId });
  return { ok: true, id };
}

export async function dismissIdea(db: pg.Pool, actor: GateActor, id: string): Promise<Result> {
  const r = await db.query("update ideas set status = 'dismissed', updated_at = now() where id = $1 and status = 'proposed'", [id]);
  if (r.rowCount === 0) return { ok: false, message: "That idea is no longer waiting." };
  await recordAudit(db, "idea.dismissed", { ideaId: id, sessionId: actor.sessionId });
  return { ok: true };
}

/** Claims the idea (proposed -> drafting) so a double click makes one video, starts a normal video, then links it. */
export async function draftIdea(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, id: string, choice: { kind: string; language: string }): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  return draftIdeaAs(db, queue, actor.sessionId, id, choice);
}

/** Draft now for the owner (session id) or the overnight scheduler (null): one path, so both make the same normal video. */
export async function draftIdeaAs(db: pg.Pool, queue: EnqueueOnly, sessionId: string | null, id: string, choice: { kind: string; language: string }): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  const claim = await db.query<{ topic: string; hook: string; why: string }>(
    "update ideas set status = 'drafting', updated_at = now() where id = $1 and status = 'proposed' returning topic, hook, why",
    [id],
  );
  const idea = claim.rows[0];
  if (!idea) return { ok: false, message: "That idea is no longer waiting." };
  const notes = [idea.hook && `Hook: ${idea.hook}`, idea.why && `Why: ${idea.why}`].filter(Boolean).join("\n");
  const input = newVideoSchema.safeParse({ topic: idea.topic, language: choice.language, kind: choice.kind, format: "short", notes: notes || undefined });
  const release = () => db.query("update ideas set status = 'proposed', updated_at = now() where id = $1 and status = 'drafting'", [id]);
  if (!input.success) {
    await release();
    return { ok: false, message: input.error.issues[0]?.message ?? "Check the choices and try again." };
  }
  let r;
  try {
    r = await startVideo(db, queue, sessionId, input.data);
  } catch {
    await release();
    return { ok: false, message: "Could not start the video. Nothing was saved. Try again in a minute." };
  }
  if (!r.ok) {
    await release();
    return r;
  }
  await db.query("update ideas set status = 'drafted', video_id = $2, updated_at = now() where id = $1", [id, r.videoId]);
  await recordAudit(db, "idea.drafted", { ideaId: id, videoId: r.videoId, kind: input.data.kind, sessionId });
  return r;
}
