import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import type { Lang } from "@/server/core/lang";
import { capStatus, nextPartNo, seriesSettingsSchema, swapTarget, type CapState, type EpisodeInput, type NewSeriesInput, type SeriesSettings } from "@/server/core/series";
import { newVideoSchema } from "@/server/core/videos-view";
import { recordAudit } from "@/server/db/audit";
import type { EnqueueOnly } from "@/server/db/pipeline";
import { runsFor, uploadFor, type StripInput } from "@/server/db/queue-data";
import { atomic, toNumber } from "@/server/db/stages";
import { startVideo } from "@/server/db/video-create";

// Series: planned parts that each become a normal video when the owner starts them. Text is untrusted and was cleaned by
// parseSeriesForm / parseEpisodeList; every query is parameterised. Nothing here approves, publishes or uploads.
// The series spend cap is checked before a part starts and shown against the sum of its videos' spend. The pipeline's
// own reservation scopes are per video, day and month (not per series), so the cap does not stop a stage already running.

type Result = { ok: true } | { ok: false; message: string };

export interface PartRow {
  partNo: number;
  title: string;
  oneLine: string;
  format: "short" | "long";
  status: "planned" | "started" | "dropped";
  videoId: string | null;
  videoStatus: string | null;
  strip: StripInput | null;
}
export interface SeriesListRow {
  id: string;
  title: string;
  channelTitle: string;
  language: Lang;
  formats: string;
  partsPlanned: number;
  partsStarted: number;
  capMicroUsd: number | null;
  spentMicroUsd: number;
  cap: { state: CapState; pct: number };
}
export interface SeriesDetail extends SeriesListRow {
  premise: string;
  channelId: string | null;
  settings: SeriesSettings;
  parts: PartRow[];
}

const SPENT = `coalesce((select sum(si.actual_micro_usd) from spend_intents si join stage_runs sr on sr.id = si.stage_run_id join videos v on v.id = sr.video_id
                          where v.series_id = s.id and si.status = 'done'), 0)::text`;

type ListDb = { id: string; title: string; channel_title: string | null; language: Lang; formats: string; parts_planned: number; started: string; cap: string | null; spent: string };
const toList = (r: ListDb): SeriesListRow => {
  const cap = r.cap === null ? null : toNumber(r.cap);
  const spent = toNumber(r.spent);
  return { id: r.id, title: r.title, channelTitle: r.channel_title ?? "", language: r.language, formats: r.formats, partsPlanned: r.parts_planned, partsStarted: Number(r.started), capMicroUsd: cap, spentMicroUsd: spent, cap: capStatus(spent, cap) };
};
const LIST_SQL = `select s.id, s.title, c.title as channel_title, s.language, s.formats, s.parts_planned, s.cap_micro_usd::text as cap, ${SPENT} as spent,
                         (select count(*) from series_parts p where p.series_id = s.id and p.status = 'started')::text as started
                    from series s left join youtube_channels c on c.channel_id = s.channel_id`;

export async function listSeries(db: pg.Pool): Promise<SeriesListRow[]> {
  const { rows } = await db.query<ListDb>(`${LIST_SQL} where s.status <> 'archived' order by s.created_at desc, s.id`);
  return rows.map(toList);
}

export async function getSeries(db: pg.Pool, id: string): Promise<SeriesDetail | null> {
  const head = await db.query<ListDb & { premise: string; channel_id: string | null; settings: unknown }>(
    `select s.premise, s.channel_id, s.settings, s.id, s.title, c.title as channel_title, s.language, s.formats, s.parts_planned, s.cap_micro_usd::text as cap, ${SPENT} as spent,
            (select count(*) from series_parts p where p.series_id = s.id and p.status = 'started')::text as started
       from series s left join youtube_channels c on c.channel_id = s.channel_id where s.id = $1`,
    [id],
  );
  const h = head.rows[0];
  if (!h) return null;
  const parts = await db.query<{ part_no: number; title: string; one_line: string; format: "short" | "long"; status: PartRow["status"]; video_id: string | null; video_status: string | null }>(
    `select p.part_no, p.title, p.one_line, p.format, p.status, p.video_id, v.status as video_status
       from series_parts p left join videos v on v.id = p.video_id where p.series_id = $1 order by p.part_no`,
    [id],
  );
  const settings = seriesSettingsSchema.safeParse(h.settings);
  return {
    ...toList(h),
    premise: h.premise,
    channelId: h.channel_id,
    settings: settings.success ? settings.data : {},
    parts: await Promise.all(
      parts.rows.map(async (p): Promise<PartRow> => ({
        partNo: p.part_no, title: p.title, oneLine: p.one_line, format: p.format, status: p.status, videoId: p.video_id, videoStatus: p.video_status,
        strip: p.video_id ? { runs: await runsFor(db, p.video_id), openGate: null, upload: await uploadFor(db, p.video_id) } : null,
      })),
    ),
  };
}

export async function createSeries(db: pg.Pool, actor: GateActor, i: NewSeriesInput): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  if (i.channelId && !(await db.query("select 1 from youtube_channels where channel_id = $1", [i.channelId])).rowCount) return { ok: false, message: "That channel is not connected." };
  const { rows } = await db.query<{ id: string }>(
    "insert into series (title, premise, channel_id, language, formats, settings, cap_micro_usd) values ($1, $2, $3, $4, $5, $6::jsonb, $7) returning id",
    [i.title, i.premise, i.channelId, i.language, i.formats, JSON.stringify(i.settings), i.capMicroUsd],
  );
  const id = rows[0]!.id;
  await recordAudit(db, "series.created", { seriesId: id, channelId: i.channelId, formats: i.formats, hasCap: i.capMicroUsd !== null, sessionId: actor.sessionId });
  return { ok: true, id };
}

/** Appends episodes after the highest part number (dropped parts keep theirs). Locks the series row so two adds never share a number. */
export async function planParts(db: pg.Pool, seriesId: string, eps: readonly EpisodeInput[]): Promise<Result> {
  return atomic(db, async (q): Promise<Result> => {
    const s = await q.query<{ formats: string }>("select formats from series where id = $1 for update", [seriesId]);
    if (!s.rows[0]) return { ok: false, message: "That series was not found." };
    const have = await q.query<{ part_no: number }>("select part_no from series_parts where series_id = $1", [seriesId]);
    let no = nextPartNo(have.rows.map((r) => r.part_no));
    const format = s.rows[0].formats === "long" ? "long" : "short";
    for (const e of eps) await q.query("insert into series_parts (series_id, part_no, title, one_line, format) values ($1, $2, $3, $4, $5)", [seriesId, no++, e.title, e.oneLine, format]);
    await q.query("update series set parts_planned = (select count(*) from series_parts where series_id = $1 and status <> 'dropped') where id = $1", [seriesId]);
    return { ok: true };
  });
}

/** A planned part swaps numbers with its planned neighbour; started and dropped parts keep theirs. */
export async function movePart(db: pg.Pool, seriesId: string, partNo: number, dir: "up" | "down"): Promise<Result> {
  return atomic(db, async (q): Promise<Result> => {
    await q.query("select 1 from series where id = $1 for update", [seriesId]);
    const planned = await q.query<{ part_no: number }>("select part_no from series_parts where series_id = $1 and status = 'planned'", [seriesId]);
    const other = swapTarget(planned.rows.map((r) => r.part_no), partNo, dir);
    if (other === null) return { ok: false, message: "That part cannot move that way." };
    // Park one row on a number no part can reach so the primary key never sees two equal numbers.
    await q.query("update series_parts set part_no = 1000000 where series_id = $1 and part_no = $2", [seriesId, partNo]);
    await q.query("update series_parts set part_no = $3 where series_id = $1 and part_no = $2", [seriesId, other, partNo]);
    await q.query("update series_parts set part_no = $2 where series_id = $1 and part_no = 1000000", [seriesId, other]);
    return { ok: true };
  });
}

export async function dropPart(db: pg.Pool, seriesId: string, partNo: number): Promise<Result> {
  const r = await db.query("update series_parts set status = 'dropped' where series_id = $1 and part_no = $2 and status = 'planned'", [seriesId, partNo]);
  if (r.rowCount === 0) return { ok: false, message: "That part is no longer planned." };
  await db.query("update series set parts_planned = (select count(*) from series_parts where series_id = $1 and status <> 'dropped') where id = $1", [seriesId]);
  return { ok: true };
}

/** Claims the part (planned -> started) so a double click makes one video, starts a normal video, then links it. */
export async function startPart(db: pg.Pool, queue: EnqueueOnly, actor: GateActor, seriesId: string, partNo: number): Promise<{ ok: true; videoId: string } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const s = await getSeries(db, seriesId);
  if (!s) return { ok: false, message: "That series was not found." };
  if (s.cap.state === "over") return { ok: false, message: "This series has reached its spend cap. Raise the cap or stop here." };
  const claim = await db.query<{ title: string; one_line: string; format: string }>(
    "update series_parts set status = 'started' where series_id = $1 and part_no = $2 and status = 'planned' and format = 'short' returning title, one_line, format",
    [seriesId, partNo],
  );
  const part = claim.rows[0];
  if (!part) {
    const p = s.parts.find((x) => x.partNo === partNo);
    return { ok: false, message: p?.status === "planned" && p.format === "long" ? "Long videos come in a later release. This part stays planned." : "That part is no longer planned." };
  }
  const release = () => db.query("update series_parts set status = 'planned' where series_id = $1 and part_no = $2 and status = 'started' and video_id is null", [seriesId, partNo]);
  const notes = [`Part ${partNo} of ${s.partsPlanned} of the series "${s.title}".`, s.premise && `Series idea: ${s.premise}`, part.one_line && `This part: ${part.one_line}`].filter(Boolean).join("\n");
  const input = newVideoSchema.safeParse({ topic: part.title, language: s.language, kind: "tsx", format: "short", notes, style: s.settings.style });
  if (!input.success) {
    await release();
    return { ok: false, message: input.error.issues[0]?.message ?? "Check the part and try again." };
  }
  let r;
  try {
    r = await startVideo(db, queue, actor.sessionId, input.data, s.channelId);
  } catch {
    await release();
    return { ok: false, message: "Could not start the video. Nothing was saved. Try again in a minute." };
  }
  if (!r.ok) {
    await release();
    return r;
  }
  await db.query("update videos set series_id = $2, part_no = $3 where id = $1", [r.videoId, seriesId, partNo]);
  await db.query("update series_parts set video_id = $3 where series_id = $1 and part_no = $2", [seriesId, partNo, r.videoId]);
  await recordAudit(db, "series.part_started", { seriesId, partNo, videoId: r.videoId, sessionId: actor.sessionId });
  return r;
}
