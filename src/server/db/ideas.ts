import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { findSimilar, type IdeaInput } from "@/server/core/ideas";
import { channelLang } from "@/server/core/idea-research";
import type { Lang } from "@/server/core/lang";
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
  /** The channel the idea is for (null = none), its title, and the narration language Draft now starts with. */
  channelId: string | null;
  channelTitle: string;
  language: Lang;
}

type Result = { ok: true } | { ok: false; message: string };

export async function listIdeas(db: pg.Pool): Promise<IdeaRow[]> {
  const { rows } = await db.query<Omit<IdeaRow, "videoId" | "score" | "channelId" | "channelTitle" | "language"> & { video_id: string | null; score: string; channel_id: string | null; title: string | null; lang: string | null }>(
    `select i.id, i.topic, i.hook, i.why, i.sources, i.score, i.status, i.video_id, i.channel_id, c.title, c.default_language as lang
       from ideas i left join youtube_channels c on c.channel_id = i.channel_id
      where i.status <> 'dismissed' order by (i.status = 'proposed') desc, i.score desc, i.created_at`,
  );
  return rows.map(({ video_id, score, channel_id, title, lang, ...r }) => ({ ...r, score: Number(score), videoId: video_id, channelId: channel_id, channelTitle: title ?? "", language: channelLang(lang) }));
}

/** Connected channels, for the channel selects. */
export async function connectedChannelOptions(db: pg.Pool): Promise<Array<{ channelId: string; title: string }>> {
  const { rows } = await db.query<{ channel_id: string; title: string }>("select channel_id, title from youtube_channels where status = 'connected' order by created_at, id");
  return rows.map((r) => ({ channelId: r.channel_id, title: r.title }));
}

/** Rejects a topic that is too like any idea ever held (dismissed ones too, as the old app did) or any video topic. */
export async function addIdea(db: pg.Pool, actor: GateActor, i: IdeaInput, channelId: string | null = null): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (channelId && !(await db.query("select 1 from youtube_channels where channel_id = $1", [channelId])).rowCount) return { ok: false, message: "That channel is not connected." };
  return insertIdea(db, i, "manual", actor.sessionId, channelId);
}

/** The idea researcher's door: the same checks and table as addIdea, marked origin 'research' (the owner's session id, or null for the worker). */
export async function addResearchIdea(db: pg.Pool, i: IdeaInput, sessionId: string | null, channelId: string | null = null): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  return insertIdea(db, i, "research", sessionId, channelId);
}

async function insertIdea(db: pg.Pool, i: IdeaInput, origin: "manual" | "research", sessionId: string | null, channelId: string | null): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const { rows: known } = await db.query<{ topic: string }>("select topic from ideas union all select topic from videos");
  const dup = findSimilar(i.topic, known.map((k) => k.topic));
  if (dup) return { ok: false, message: `Too like a topic you already have: "${dup.slice(0, 80)}".` };
  const { rows } = await db.query<{ id: string }>(
    "insert into ideas (topic, hook, why, sources, score, origin, channel_id) values ($1, $2, $3, $4::jsonb, $5, $6, $7) returning id",
    [i.topic, i.hook, i.why, JSON.stringify(i.sources), i.score, origin, channelId],
  );
  const id = rows[0]!.id;
  await recordAudit(db, "idea.added", { ideaId: id, sources: i.sources.length, origin, sessionId, channelId });
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
  const claim = await db.query<{ topic: string; hook: string; why: string; channel_id: string | null }>(
    "update ideas set status = 'drafting', updated_at = now() where id = $1 and status = 'proposed' returning topic, hook, why, channel_id",
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
    r = await startVideo(db, queue, sessionId, input.data, idea.channel_id);
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
