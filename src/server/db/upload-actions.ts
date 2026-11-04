import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { publishAtProblem, publishLeadProblem, visibilityProblem, type Visibility } from "@/server/core/publish-rules";
import type { Keyring } from "@/server/core/vault-crypto";
import type { UploadQueue } from "@/server/queue/job-queue";
import { recordAudit } from "./audit";
import { getSetting } from "./settings";
import { finishUpload, isUnclearReason } from "./uploads";
import { addContent, latestContent } from "./videos";
import { getAccessToken, reserveQuota, type GoogleHttp } from "./youtube-channels";

// The owner's three publish actions besides the gate itself: choose visibility/schedule/channel, ask YouTube whether an
// unclear upload is live, and ask for a failed upload to be sent again. None of them sends a byte: a re-send is only a
// request (upload_log `retry_requested`) that the worker honours after the full job-time checks.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const PUBLIC_PHRASE = "public";
export type Result = { ok: true; message: string } | { ok: false; message: string };
const no = (message: string): Result => ({ ok: false, message });

export interface PublishChoice {
  visibility: Visibility;
  /** UTC instant string or null */
  publishAt: string | null;
  /** YouTube channel id of a connected channel */
  channelId: string;
  /** what the owner typed for a public choice */
  typed?: string;
}

/**
 * Owner session only. Saves visibility, schedule and channel as a NEW metadata version (and the video's channel), so any
 * earlier publish approval stops counting. Public needs the channel's allow-public switch, the kill switch off and the typed word.
 */
export async function savePublishChoice(db: pg.Pool, videoId: string, c: PublishChoice, actor: GateActor): Promise<Result> {
  if (actorProblem(actor)) return no(ACTOR_REASON);
  const vp = visibilityProblem(c.visibility);
  if (vp) return no(vp);
  const publishAt = c.publishAt ?? null;
  const ap = publishAtProblem(publishAt);
  if (ap) return no(ap);
  if (publishAt !== null && c.visibility !== "private") return no("a scheduled time works only with private: choose private, or remove the time");
  const v = await db.query<{ status: string; channel_id: string | null }>("select status, channel_id from videos where id = $1", [videoId]);
  if (!v.rows[0]) return no("That video was not found.");
  if (!["active", "waiting"].includes(v.rows[0].status)) return no("This video is no longer in production.");
  const ch = (await db.query<{ status: string; allow_public: boolean }>("select status, allow_public from youtube_channels where channel_id = $1", [c.channelId])).rows[0];
  if (!ch || ch.status !== "connected") return no("Choose a channel that is connected and confirmed (Settings, Channels).");
  if (c.visibility === "public") {
    if (!ch.allow_public) return no("Public is switched off for this channel. Turn on Allow public in Settings, Channels, or choose private or unlisted.");
    if ((await getSetting(db, "policy.allow_public")) !== true) return no("Public publishing is switched off in settings (allow public); choose private or unlisted.");
    if ((await getSetting(db, "uploads.kill_switch")) !== false) return no("Uploads are switched off (kill switch), so public is not available.");
    if (c.typed?.trim().toLowerCase() !== PUBLIC_PHRASE) return no(`Type the word ${PUBLIC_PHRASE} to choose public.`);
  }
  if (publishAt !== null) {
    const now = Number((await db.query<{ ms: string }>("select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms")).rows[0]!.ms);
    const lead = publishLeadProblem(publishAt, now);
    if (lead) return no("Pick a time at least 60 minutes from now.");
  }
  const prev = await latestContent(db, videoId, "metadata");
  if (!prev || !isObj(prev.body) || typeof prev.body.title !== "string") return no("Save the upload details first (Titles tab).");
  const at = publishAt === null ? null : new Date(publishAt).toISOString();
  const same = prev.body.visibility === c.visibility && (prev.body.publish_at ?? null) === at && v.rows[0].channel_id === c.channelId;
  if (!same) {
    // channel first, then the metadata version: both change the publish hash, so a half-applied choice still voids an approval
    if (v.rows[0].channel_id !== c.channelId) await db.query("update videos set channel_id = $2, updated_at = now() where id = $1", [videoId, c.channelId]);
    const body = { ...prev.body, visibility: c.visibility, publish_at: at };
    await addContent(db, videoId, "metadata", { body, sha256: sha256Hex(canonicalJson(body)), producedBy: null });
  }
  await recordAudit(db, "publish.choice_saved", { videoId, sessionId: actor.sessionId, visibility: c.visibility, publishAt: at, channelId: c.channelId, changed: !same });
  return { ok: true, message: same ? "Nothing changed." : "Saved. A publish approval you gave earlier no longer counts: approve again." };
}

interface FailedRow { id: string; video_id: string; channel_id: string | null; status: string; youtube_id: string | null; failure_reason: string | null; attempt: number; started_ms: string | null; row_id: string | null }
async function failedRow(db: pg.Pool, uploadId: string): Promise<FailedRow | undefined> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) return undefined;
  return (await db.query<FailedRow>(
    `select u.id, u.video_id, u.channel_id, u.status, u.youtube_id, u.failure_reason, u.attempt, (extract(epoch from u.started_at) * 1000)::bigint::text as started_ms,
            (select c.id from youtube_channels c where c.channel_id = u.channel_id) as row_id
       from uploads u where u.id = $1`, [uploadId])).rows[0];
}

/**
 * Owner session only. For an UNCLEAR failed upload (bytes may have reached YouTube): looks in the channel's own uploads list for a
 * video with the approved title made since this attempt began. Found: records the video id (late success). Not found: records
 * `checked_not_found`, which is what allows a re-send. Reads only; never uploads.
 */
export async function checkOnYoutube(db: pg.Pool, ring: Keyring | (() => Keyring), http: GoogleHttp, uploadId: string, actor: GateActor): Promise<Result> {
  if (actorProblem(actor)) return no(ACTOR_REASON);
  const r = await failedRow(db, uploadId);
  if (!r || r.status !== "upload_failed" || r.youtube_id !== null || !isUnclearReason(r.failure_reason) || !r.row_id) return no("There is nothing to check for this upload.");
  const meta = await latestContent(db, r.video_id, "metadata");
  const title = isObj(meta?.body) && typeof meta.body.title === "string" ? meta.body.title : null;
  if (!title) return no("The upload title is missing.");
  const tok = await getAccessToken(db, ring, http, r.row_id);
  if (!tok.ok) return no("Could not sign in to YouTube for this channel. Reconnect it, or look in YouTube Studio yourself.");
  const auth = { headers: { authorization: `Bearer ${tok.accessToken}` } };
  let items: Array<{ snippet?: { title?: unknown; resourceId?: { videoId?: unknown }; publishedAt?: unknown; channelId?: unknown } }> = [];
  try {
    if (!(await reserveQuota(db, "channels.list")) || !(await reserveQuota(db, "playlistItems.list"))) return no("Not enough YouTube quota left today to check. Look in YouTube Studio yourself.");
    const ch = await http("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true", auth);
    const cj = ch.ok ? ((await ch.json()) as { items?: Array<{ id?: unknown; contentDetails?: { relatedPlaylists?: { uploads?: unknown } } }> }) : null;
    const mine = cj?.items?.find((i) => i.id === r.channel_id);
    const list = mine?.contentDetails?.relatedPlaylists?.uploads;
    if (typeof list !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(list)) return no("YouTube did not show this channel's uploads. Look in YouTube Studio yourself.");
    const pl = await http(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(list)}`, auth);
    if (!pl.ok) return no("YouTube did not answer. Look in YouTube Studio yourself.");
    items = ((await pl.json()) as { items?: typeof items }).items ?? [];
  } catch {
    return no("Could not reach YouTube. Look in YouTube Studio yourself.");
  }
  const since = r.started_ms ? Number(r.started_ms) - 10 * 60_000 : 0;
  const hit = items.find((i) => i.snippet?.title === title && typeof i.snippet?.resourceId?.videoId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(i.snippet.resourceId.videoId) && (!Number.isFinite(since) || Date.parse(String(i.snippet?.publishedAt)) >= since));
  if (hit) {
    const id = hit.snippet!.resourceId!.videoId as string;
    const done = await finishUpload(db, uploadId, r.attempt, { kind: "uploaded", youtubeId: id });
    await recordAudit(db, "upload.checked", { uploadId, sessionId: actor.sessionId, outcome: done ? "found" : "found_not_recorded", youtubeId: id });
    return done ? { ok: true, message: "Found it on YouTube. The upload is marked as done." } : no("Found a matching video but could not record it. Open YouTube Studio.");
  }
  await db.query("insert into upload_log (upload_id, event) values ($1, 'checked_not_found')", [uploadId]);
  await recordAudit(db, "upload.checked", { uploadId, sessionId: actor.sessionId, outcome: "not_found" });
  return { ok: true, message: "No matching video in the channel's recent uploads. Look in YouTube Studio too; if it is not there, you can send it again." };
}

/**
 * Owner session only. A clearly failed upload may be sent again; an UNCLEAR one only after "Check on YouTube" found nothing. This
 * writes the request and queues the job; the worker re-runs every job-time check and decides.
 */
export async function requestRetry(db: pg.Pool, queue: Pick<UploadQueue, "enqueueUpload">, uploadId: string, actor: GateActor): Promise<Result> {
  if (actorProblem(actor)) return no(ACTOR_REASON);
  const r = await failedRow(db, uploadId);
  if (!r || r.status !== "upload_failed" || r.youtube_id !== null) return no("This upload cannot be sent again.");
  if (isUnclearReason(r.failure_reason)) {
    const checked = await db.query("select 1 from upload_log l join uploads u on u.id = l.upload_id where l.upload_id = $1 and l.event = 'checked_not_found' and l.at > u.finished_at limit 1", [uploadId]);
    if (checked.rowCount !== 1) return no("Check on YouTube first. This upload may already be live.");
  }
  await db.query("insert into upload_log (upload_id, event) values ($1, 'retry_requested')", [uploadId]);
  await recordAudit(db, "upload.retry_requested", { uploadId, sessionId: actor.sessionId, unclear: isUnclearReason(r.failure_reason) });
  try {
    await queue.enqueueUpload(uploadId);
  } catch {
    return no("The upload queue is not reachable right now. Try again in a minute.");
  }
  return { ok: true, message: "Queued. The uploader will check everything again before it sends." };
}

export interface UploadListRow {
  id: string;
  videoId: string;
  topic: string;
  status: "publish_approved" | "uploading" | "uploaded" | "upload_failed";
  /** a failure that may still be live on YouTube */
  unclear: boolean;
  /** an unclear failure that "Check on YouTube" has already searched without finding the video */
  checkedNotFound: boolean;
  reason: string | null;
  channelTitle: string | null;
  visibility: string | null;
  publishAt: string | null;
  youtubeId: string | null;
  /** what YouTube reported back when it differs from what was approved */
  keptPrivate: boolean;
  bytesSent: number;
  bytesTotal: number | null;
  createdAt: string;
}

export async function listUploads(db: pg.Pool, limit = 50): Promise<UploadListRow[]> {
  const { rows } = await db.query(
    `select u.id, u.video_id, v.topic, u.status, u.failure_reason, u.youtube_id, u.bytes_sent::text, u.bytes_total::text, u.created_at::text,
            c.title as channel_title,
            (select m.body from video_content m where m.video_id = u.video_id and m.kind = 'metadata' order by m.version desc limit 1) as meta,
            exists (select 1 from upload_log l where l.upload_id = u.id and l.event like 'privacy_mismatch:%') as kept_private,
            exists (select 1 from upload_log l where l.upload_id = u.id and l.event = 'checked_not_found' and l.at > coalesce(u.finished_at, 'epoch')) as checked
       from uploads u join videos v on v.id = u.video_id left join youtube_channels c on c.channel_id = u.channel_id
      order by u.created_at desc, u.id limit $1`,
    [limit],
  );
  return rows.map((r) => {
    const meta = isObj(r.meta) ? r.meta : {};
    return {
      id: r.id, videoId: r.video_id, topic: r.topic, status: r.status, unclear: r.status === "upload_failed" && r.youtube_id === null && isUnclearReason(r.failure_reason),
      checkedNotFound: r.checked, reason: r.failure_reason, channelTitle: r.channel_title,
      visibility: typeof meta.visibility === "string" ? meta.visibility : null, publishAt: typeof meta.publish_at === "string" ? meta.publish_at : null,
      youtubeId: r.youtube_id, keptPrivate: r.kept_private, bytesSent: Number(r.bytes_sent), bytesTotal: r.bytes_total === null ? null : Number(r.bytes_total), createdAt: r.created_at,
    };
  });
}
