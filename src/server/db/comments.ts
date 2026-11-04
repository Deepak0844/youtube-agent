import type pg from "pg";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { REPLY_INSERT_URL, insertBody, parseThreads, replyTextProblem, riskReasons, seenHash, threadsUrl } from "@/server/core/comments";
import { isLang, type Lang } from "@/server/core/lang";
import { safeReason } from "@/server/core/paid-call";
import { POLICY_DEFAULTS, type Policy } from "@/server/core/policy";
import { uuidv7 } from "@/server/core/ids";
import type { Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "./audit";
import { inTx, type EnqueueOnly } from "./pipeline";
import { loadPolicy } from "./policy-file";
import { getSetting } from "./settings";
import { getAccessToken, reserveQuota, type GoogleHttp } from "./youtube-channels";

// Comment sync (read only), reply drafts, and the ONE place a reply can reach YouTube.
//
// Human-gate rule: a reply is posted only by postReply with an owner session actor, for one reply the owner has seen (the `seen`
// hash covers the comment text and the reply text as shown). The agent, a token or any no-actor path is refused before the
// database is touched. Dry run is the default: "post" then records the request that WOULD be sent and calls nobody.
// An unclear outcome (timeout, 5xx after the request left) is never retried: it could post twice.

export type SyncBy = { kind: "session"; sessionId: string } | { kind: "worker" };
export interface SyncResult {
  videos: number;
  newComments: number;
  failed: number;
  quotaStopped: boolean;
  skipped: Array<{ channel: string; reason: string }>;
  draftsQueued: number;
}

const SKIP_REASON = { needs_reconnect: "needs reconnecting (Settings, Channels)", unconfirmed: "not confirmed as yours yet (Settings, Channels)", unavailable: "could not sign in to Google" } as const;
const MAX_VIDEOS = 50;

interface Target { videoId: string; youtubeId: string; channelId: string; rowId: string | null; status: string | null; title: string | null; lang: Lang }

async function json(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** "Run now": reads the newest top-level comments of every uploaded video on a connected, confirmed channel. Upserts; never replies, never retries. */
export async function syncComments(
  db: pg.Pool,
  ring: Keyring | (() => Keyring),
  http: GoogleHttp,
  by: SyncBy,
  opts: { queue?: EnqueueOnly } = {},
): Promise<SyncResult> {
  const out: SyncResult = { videos: 0, newComments: 0, failed: 0, quotaStopped: false, skipped: [], draftsQueued: 0 };
  const { rows } = await db.query<{ video_id: string; youtube_id: string; channel_id: string; row_id: string | null; status: string | null; title: string | null; language: string }>(
    `select * from (
       select distinct on (u.video_id) u.video_id, u.youtube_id, u.channel_id, c.id as row_id, c.status, c.title, v.language, u.finished_at
         from uploads u join videos v on v.id = u.video_id left join youtube_channels c on c.channel_id = u.channel_id
        where u.status = 'uploaded' and u.youtube_id is not null
        order by u.video_id, u.finished_at desc nulls last) t
      order by finished_at desc nulls last limit ${MAX_VIDEOS}`,
  );
  const byChannel = new Map<string, Target[]>();
  for (const r of rows) {
    const t: Target = { videoId: r.video_id, youtubeId: r.youtube_id, channelId: r.channel_id, rowId: r.row_id, status: r.status, title: r.title, lang: isLang(r.language) ? r.language : "en" };
    byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), t]);
  }
  const withNew = new Set<string>();
  for (const [channelId, targets] of byChannel) {
    const first = targets[0]!;
    const name = first.title ?? channelId;
    if (!first.rowId) {
      out.skipped.push({ channel: name, reason: "the channel is no longer connected" });
      continue;
    }
    const tok = await getAccessToken(db, ring, http, first.rowId);
    if (!tok.ok) {
      out.skipped.push({ channel: name, reason: SKIP_REASON[tok.reason] });
      continue;
    }
    const auth = { headers: { authorization: `Bearer ${tok.accessToken}` } };
    for (const t of targets) {
      if (out.quotaStopped) break;
      if (!(await reserveQuota(db, "commentThreads.list"))) {
        out.quotaStopped = true;
        break;
      }
      out.videos++;
      let items: ReturnType<typeof parseThreads>;
      try {
        const res = await http(threadsUrl(t.youtubeId), auth);
        if (!res.ok) {
          out.failed++;
          continue;
        }
        items = parseThreads(await json(res));
      } catch {
        out.failed++;
        continue;
      }
      for (const c of items) {
        if (c.authorChannelId === channelId) continue; // the owner's own top-level comment is not a question to answer
        const reasons = riskReasons(c.text, t.lang);
        const ins = await db.query<{ inserted: boolean }>(
          `insert into comments (youtube_comment_id, video_id, channel_id, author_name, text, published_at, needs_eyes, risk_reasons)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (youtube_comment_id) do update set text = excluded.text, author_name = excluded.author_name,
             needs_eyes = excluded.needs_eyes, risk_reasons = excluded.risk_reasons, updated_at = now()
             where comments.text is distinct from excluded.text and comments.status not in ('posted', 'ignored')
           returning (xmax = 0) as inserted`,
          [c.id, t.videoId, channelId, c.authorName, c.text, c.publishedAt, reasons.length > 0, reasons],
        );
        if (ins.rows[0]?.inserted) {
          out.newComments++;
          withNew.add(t.videoId);
        }
      }
    }
  }
  await db.query("insert into comment_sync_state (id, last_sync_at) values (1, now()) on conflict (id) do update set last_sync_at = now()");
  if (opts.queue) {
    for (const videoId of withNew) {
      const r = await requestReplyDrafts(db, opts.queue, videoId, undefined, { auto: true }).catch(() => ({ ok: false as const }));
      if (r.ok) out.draftsQueued++;
    }
  }
  await recordAudit(db, "comments.synced", {
    by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null,
    videos: out.videos, newComments: out.newComments, failed: out.failed, skippedChannels: out.skipped.length, quotaStopped: out.quotaStopped, draftsQueued: out.draftsQueued,
  });
  return out;
}

export function syncMessage(r: SyncResult): string {
  const parts = [`Read ${r.videos} video${r.videos === 1 ? "" : "s"}: ${r.newComments} new comment${r.newComments === 1 ? "" : "s"}`];
  if (r.draftsQueued) parts.push(`drafting replies for ${r.draftsQueued} video${r.draftsQueued === 1 ? "" : "s"} (they wait for your review)`);
  if (r.failed) parts.push(`${r.failed} could not be read (nothing is retried on its own)`);
  if (r.quotaStopped) parts.push("stopped: not enough YouTube quota left today");
  for (const s of r.skipped) parts.push(`skipped ${s.channel}: ${s.reason}`);
  return parts.join(". ") + ".";
}

/** Worker hook: a sync at most every `everyMs` (default 6 h) by the injected clock. Read only; errors never reach the caller. */
export function throttledCommentSync(
  db: pg.Pool,
  ring: Keyring | (() => Keyring),
  http: GoogleHttp,
  queue: EnqueueOnly,
  opts: { everyMs?: number; now?: () => number } = {},
): () => Promise<void> {
  const every = opts.everyMs ?? 6 * 3600_000;
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    const t = now();
    if (t - last < every) return;
    last = t;
    await syncComments(db, ring, http, { kind: "worker" }, { queue }).catch(() => undefined);
  };
}

// ---- drafting ----

export type DraftRequest = { ok: true; stageRunId: string } | { ok: false; message: string };

/** Queues the on-demand `reply_drafts` stage for one video that has comments without a draft. The worker pays through the 'comment_replies' route. */
export async function requestReplyDrafts(db: pg.Pool, queue: EnqueueOnly, videoId: string, sessionId?: string, opts: { auto?: boolean } = {}): Promise<DraftRequest> {
  const out = await inTx(db, async (c): Promise<DraftRequest & { hash?: string }> => {
    const v = await c.query<{ status: string }>("select status from videos where id = $1 for update", [videoId]);
    if (!v.rows[0]) return { ok: false, message: "That video was not found." };
    if (v.rows[0].status === "cancelled") return { ok: false, message: "This video was cancelled." };
    const fresh = await c.query("select 1 from comments where video_id = $1 and status = 'new' limit 1", [videoId]);
    if (!fresh.rowCount) return { ok: false, message: "There are no new comments to answer." };
    const busy = await c.query(
      `select 1 from stage_runs where video_id = $1 and name = 'reply_drafts'
          and (status in ('queued', 'running', 'needs_decision') or ($2::boolean and status = 'failed' and updated_at > now() - interval '1 day'))`,
      [videoId, opts.auto === true],
    );
    if (busy.rowCount) return { ok: false, message: "Replies are already being drafted for this video." };
    const n = await c.query<{ n: string }>("select count(*)::text as n from stage_runs where video_id = $1 and name = 'reply_drafts'", [videoId]);
    const hash = sha256Hex(canonicalJson({ stage: "reply_drafts", n: Number(n.rows[0]!.n) }));
    const id = uuidv7();
    const ins = await c.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1, $2, 'reply_drafts', 'queued', $3) on conflict do nothing", [id, videoId, hash]);
    if (!ins.rowCount) return { ok: false, message: "Drafting was just requested. Look again." };
    return { ok: true, stageRunId: id, hash };
  });
  if (!out.ok) return out;
  await queue.enqueue(out.stageRunId, 0, 0, out.hash!).catch(() => undefined); // if Redis is down the row stays queued and the reconciler enqueues it
  return { ok: true, stageRunId: out.stageRunId };
}

export interface DraftInput { videoId: string; topic: string; lang: Lang; comments: Array<{ id: string; author: string; text: string }> }

/** The new comments of one video, newest first, at most 10 per run. */
export async function loadDraftInput(db: pg.Pool, videoId: string): Promise<DraftInput | null> {
  const v = await db.query<{ topic: string; language: string }>("select topic, language from videos where id = $1", [videoId]);
  if (!v.rows[0]) return null;
  const { rows } = await db.query<{ youtube_comment_id: string; author_name: string; text: string }>(
    "select youtube_comment_id, author_name, text from comments where video_id = $1 and status = 'new' order by published_at desc nulls last, id limit 10",
    [videoId],
  );
  return { videoId, topic: v.rows[0].topic, lang: isLang(v.rows[0].language) ? v.rows[0].language : "en", comments: rows.map((r) => ({ id: r.youtube_comment_id, author: r.author_name, text: r.text })) };
}

/** Every draft starts HELD. A comment the rule flagged is 'held' ("needs your eyes"), the rest 'drafted'. Nothing is posted here. */
export async function saveDrafts(db: pg.Pool, videoId: string, replies: ReadonlyMap<string, string>): Promise<number> {
  let saved = 0;
  for (const [ytId, text] of replies) {
    const c = await db.query<{ id: string; needs_eyes: boolean }>("select id, needs_eyes from comments where youtube_comment_id = $1 and video_id = $2 and status = 'new'", [ytId, videoId]);
    const row = c.rows[0];
    if (!row) continue;
    const ins = await db.query("insert into comment_replies (comment_id, draft_text, status) values ($1, $2, 'held') on conflict do nothing", [row.id, text]);
    if (!ins.rowCount) continue;
    await db.query("update comments set status = $2, updated_at = now() where id = $1 and status = 'new'", [row.id, row.needs_eyes ? "held" : "drafted"]);
    saved++;
  }
  if (saved > 0) await recordAudit(db, "comment.drafts_added", { videoId, drafts: saved });
  return saved;
}

// ---- owner edits ----

export type EditResult = { ok: true } | { ok: false; message: string };

/** Owner session only. Editing a held reply (or a dry-run one) puts it back to held and voids any approval. */
export async function editReply(db: pg.Pool, replyId: string, text: unknown, actor: GateActor): Promise<EditResult> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const t = replyTextProblem(text);
  if (!t.ok) return { ok: false, message: t.reason };
  const r = await db.query(
    `update comment_replies set draft_text = $2, status = 'held', approved_by_session = null, approved_hash = null, approved_at = null,
            attempted_at = null, mode = null, would_send = null, error = null, updated_at = now()
      where id = $1 and status in ('held', 'draft', 'dry_run')`,
    [replyId, t.text],
  );
  if (!r.rowCount) return { ok: false, message: "That reply can no longer be edited." };
  await recordAudit(db, "comment.reply_edited", { replyId, sessionId: actor.sessionId, textHash: sha256Hex(t.text).slice(0, 16) });
  return { ok: true };
}

/** Owner session only. "Ignore": no reply will be written or posted for this comment. */
export async function ignoreComment(db: pg.Pool, commentId: string, actor: GateActor): Promise<EditResult> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const r = await db.query("update comments set status = 'ignored', updated_at = now() where id = $1 and status in ('new', 'held', 'drafted')", [commentId]);
  if (!r.rowCount) return { ok: false, message: "That comment can no longer be ignored." };
  await db.query("update comment_replies set status = 'ignored', updated_at = now() where comment_id = $1 and status in ('held', 'draft', 'dry_run')", [commentId]);
  await recordAudit(db, "comment.ignored", { commentId, sessionId: actor.sessionId });
  return { ok: true };
}

// ---- posting ----

export type PostResult = { ok: true; outcome: "dry_run" | "posted" } | { ok: false; message: string };

const PACIFIC_TODAY = "(r.attempted_at at time zone 'America/Los_Angeles')::date = (now() at time zone 'America/Los_Angeles')::date";
const prior = (needsEyes: boolean) => (needsEyes ? "held" : "drafted");

/**
 * "Approve and post" for ONE reply. Owner session only (checked first, before any database access). Inside one transaction,
 * serialised by an advisory lock, it re-reads everything on the database clock: the reply is still held, the owner saw exactly this
 * comment and reply text (`seen`), flagged comments were acknowledged, the kill switch is off, the channel is connected and confirmed,
 * the day's cap and the gap since the last reply allow it. Passing records the attempt (which uses up the slot) before anything
 * is sent, so two clicks cannot both pass and a crash cannot cause a second post.
 */
export async function postReply(
  db: pg.Pool,
  ring: Keyring | (() => Keyring),
  http: GoogleHttp,
  a: { replyId: string; seen: string; ack?: boolean; actor: GateActor },
  opts: { policy?: Pick<Policy, "repliesPerDay" | "secondsBetweenReplies"> } = {},
): Promise<PostResult> {
  if (actorProblem(a.actor)) return { ok: false, message: ACTOR_REASON };
  const policy = opts.policy ?? (() => { const p = loadPolicy(); return { repliesPerDay: p.repliesPerDay, secondsBetweenReplies: p.secondsBetweenReplies }; })();
  const cap = Math.max(0, policy.repliesPerDay ?? POLICY_DEFAULTS.repliesPerDay);
  const gap = Math.max(0, policy.secondsBetweenReplies ?? POLICY_DEFAULTS.secondsBetweenReplies);
  const client = await db.connect();
  let live: { ytParent: string; text: string; rowId: string; commentId: string; needsEyes: boolean; seen: string } | null = null;
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('ytstudio.comments.post'))");
    const q = await client.query<{
      status: string; draft_text: string; cid: string; ctext: string; needs_eyes: boolean; yt: string; channel_id: string; row_id: string | null; ch_status: string | null; cstatus: string;
    }>(
      `select r.status, r.draft_text, c.id as cid, c.text as ctext, c.needs_eyes, c.youtube_comment_id as yt, c.channel_id, c.status as cstatus, ch.id as row_id, ch.status as ch_status
         from comment_replies r join comments c on c.id = r.comment_id left join youtube_channels ch on ch.channel_id = c.channel_id
        where r.id = $1 for update of r, c`,
      [a.replyId],
    );
    const row = q.rows[0];
    const refuse = async (message: string): Promise<PostResult> => {
      await client.query("rollback");
      return { ok: false, message };
    };
    if (!row) return await refuse("That reply was not found.");
    if (row.status !== "held" && row.status !== "dry_run") return await refuse("This reply is not waiting for review any more.");
    if (row.cstatus === "ignored") return await refuse("This comment was ignored.");
    if (seenHash(row.ctext, row.draft_text) !== a.seen) return await refuse("The comment or the reply changed after you opened it. Look at it again, then approve.");
    if (row.needs_eyes && a.ack !== true) return await refuse("This comment needs your eyes: tick the box to confirm you read it.");
    if ((await getSetting(client, "uploads.kill_switch")) !== false) return await refuse("The kill switch is on, so nothing is posted.");
    if (!row.row_id || row.ch_status !== "connected") return await refuse("The channel is not connected and confirmed as yours (Settings, Channels).");
    const dry = (await getSetting(client, "comments.dry_run")) !== false;
    const mode = dry ? "dry" : "live";
    const today = await client.query<{ n: number }>(
      `select count(*)::int as n from comment_replies r join comments c on c.id = r.comment_id
        where c.channel_id = $1 and r.mode = $2 and r.attempted_at is not null and r.id <> $3 and ${PACIFIC_TODAY}`,
      [row.channel_id, mode, a.replyId],
    );
    if (today.rows[0]!.n >= cap) return await refuse(`The limit of ${cap} replies a day (Pacific time) is used up for this channel. Try again tomorrow.`);
    const last = await client.query<{ wait: number | null }>(
      `select ceil($3::int - extract(epoch from now() - max(r.attempted_at)))::int as wait from comment_replies r join comments c on c.id = r.comment_id
        where c.channel_id = $1 and r.mode = $2 and r.attempted_at is not null and r.id <> $4`,
      [row.channel_id, mode, gap, a.replyId],
    );
    const wait = last.rows[0]?.wait ?? null;
    if (wait !== null && wait > 0) return await refuse(`Wait ${wait} more second${wait === 1 ? "" : "s"} before the next reply (there is a ${gap} second gap between replies).`);

    const textHash = sha256Hex(row.draft_text).slice(0, 16);
    if (dry) {
      const would = { method: "POST", url: REPLY_INSERT_URL, parentId: row.yt, text: row.draft_text };
      await client.query(
        `update comment_replies set status = 'dry_run', mode = 'dry', attempted_at = now(), approved_by_session = $2, approved_hash = $3, approved_at = now(), would_send = $4::jsonb, error = null, updated_at = now() where id = $1`,
        [a.replyId, a.actor.sessionId, a.seen, JSON.stringify(would)],
      );
      await recordAudit(client, "comment.reply_dry_run", { replyId: a.replyId, sessionId: a.actor.sessionId, textHash });
      await client.query("commit");
      return { ok: true, outcome: "dry_run" };
    }
    await client.query(
      `update comment_replies set status = 'approved', mode = 'live', attempted_at = now(), approved_by_session = $2, approved_hash = $3, approved_at = now(), would_send = null, error = null, updated_at = now() where id = $1`,
      [a.replyId, a.actor.sessionId, a.seen],
    );
    await client.query("update comments set status = 'approved', updated_at = now() where id = $1", [row.cid]);
    await client.query("commit");
    live = { ytParent: row.yt, text: row.draft_text, rowId: row.row_id, commentId: row.cid, needsEyes: row.needs_eyes, seen: a.seen };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (!live) return { ok: false, message: "Nothing was posted." };
  const l = live;
  // Nothing has left this machine yet, so the next three failures put the reply back to held (still one click away from trying again).
  const back = async (message: string): Promise<PostResult> => {
    await db.query("update comment_replies set status = 'held', mode = null, attempted_at = null, approved_by_session = null, approved_hash = null, approved_at = null, updated_at = now() where id = $1 and status = 'approved'", [a.replyId]);
    await db.query("update comments set status = $2, updated_at = now() where id = $1 and status = 'approved'", [l.commentId, prior(l.needsEyes)]);
    return { ok: false, message: `${message} Nothing was posted.` };
  };
  if (!(await reserveQuota(db, "comments.insert"))) return back("Not enough YouTube quota is left today.");
  const tok = await getAccessToken(db, ring, http, l.rowId);
  if (!tok.ok) return back(`Could not sign in to the channel (${SKIP_REASON[tok.reason]}).`);

  const finish = async (status: "posted" | "failed", fields: { youtubeId?: string | null; error?: string | null }) => {
    await db.query("update comment_replies set status = $2, posted_youtube_id = $3, error = $4, updated_at = now() where id = $1 and status = 'approved'", [a.replyId, status, fields.youtubeId ?? null, fields.error ?? null]);
    await db.query("update comments set status = $2, updated_at = now() where id = $1 and status = 'approved'", [l.commentId, status]);
  };
  const textHash = sha256Hex(l.text).slice(0, 16);
  let res: Response;
  try {
    res = await http(REPLY_INSERT_URL, { method: "POST", headers: { authorization: `Bearer ${tok.accessToken}`, "content-type": "application/json" }, body: insertBody(l.ytParent, l.text) });
  } catch (e) {
    // The request may have left: it may or may not have been posted.
    const error = `The outcome is unclear (${safeReason(e)}). Check YouTube first before anything else; it is not retried.`;
    await finish("failed", { error });
    await recordAudit(db, "comment.reply_failed", { replyId: a.replyId, reason: "unclear", sessionId: a.actor.sessionId });
    return { ok: false, message: error };
  }
  if (res.ok) {
    const body = (await json(res)) as { id?: unknown } | null;
    const id = typeof body?.id === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(body.id) ? body.id : null;
    await finish("posted", { youtubeId: id });
    await recordAudit(db, "comment.reply_posted", { replyId: a.replyId, youtubeId: id, sessionId: a.actor.sessionId, textHash });
    return { ok: true, outcome: "posted" };
  }
  if (res.status >= 500) {
    const error = `YouTube answered ${res.status} after the request was sent, so the outcome is unclear. Check YouTube first; it is not retried.`;
    await finish("failed", { error });
    await recordAudit(db, "comment.reply_failed", { replyId: a.replyId, reason: "unclear", status: res.status, sessionId: a.actor.sessionId });
    return { ok: false, message: error };
  }
  const error = `YouTube refused the reply (${res.status}). Nothing was posted. Ignore it or write a new one.`;
  await finish("failed", { error });
  await recordAudit(db, "comment.reply_failed", { replyId: a.replyId, reason: "refused", status: res.status, sessionId: a.actor.sessionId });
  return { ok: false, message: error };
}

// ---- Engagement page data ----

export interface CommentView {
  id: string;
  author: string;
  text: string;
  publishedIst: string | null;
  status: string;
  needsEyes: boolean;
  riskReasons: string[];
  reply: { id: string; text: string; status: string; error: string | null; seen: string; wouldSend: { parentId?: string; text?: string } | null } | null;
}
export interface EngagementVideo { videoId: string; topic: string; channelTitle: string | null; comments: CommentView[] }
export interface EngagementView {
  dryRun: boolean;
  killSwitch: boolean;
  lastSyncIst: string | null;
  cap: number;
  gapSeconds: number;
  used: Array<{ channelId: string; title: string; used: number }>;
  videos: EngagementVideo[];
}

export async function loadEngagement(db: pg.Pool): Promise<EngagementView> {
  const policy = loadPolicy();
  const dryRun = (await getSetting(db, "comments.dry_run")) !== false;
  const killSwitch = (await getSetting(db, "uploads.kill_switch")) !== false;
  const sync = await db.query<{ ist: string | null }>("select to_char(last_sync_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') as ist from comment_sync_state where id = 1");
  const used = await db.query<{ channel_id: string; title: string | null; n: number }>(
    `select ch.channel_id, ch.title, (select count(*)::int from comment_replies r join comments c on c.id = r.comment_id
        where c.channel_id = ch.channel_id and r.mode = $1 and r.attempted_at is not null and ${PACIFIC_TODAY}) as n
       from youtube_channels ch order by ch.created_at, ch.id`,
    [dryRun ? "dry" : "live"],
  );
  const { rows } = await db.query<{
    video_id: string; topic: string; channel_title: string | null; cid: string; author_name: string; text: string; pub: string | null; status: string; needs_eyes: boolean; risk_reasons: string[];
    rid: string | null; rtext: string | null; rstatus: string | null; rerror: string | null; would_send: { parentId?: string; text?: string } | null;
  }>(
    `select c.video_id, v.topic, ch.title as channel_title, c.id as cid, c.author_name, c.text, to_char(c.published_at at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH24:MI') as pub,
            c.status, c.needs_eyes, c.risk_reasons, r.id as rid, r.draft_text as rtext, r.status as rstatus, r.error as rerror, r.would_send
       from comments c join videos v on v.id = c.video_id left join youtube_channels ch on ch.channel_id = c.channel_id
       left join lateral (select * from comment_replies x where x.comment_id = c.id order by x.created_at desc, x.id limit 1) r on true
      order by v.created_at desc, c.video_id, c.published_at desc nulls last, c.id limit 500`,
  );
  const videos = new Map<string, EngagementVideo>();
  for (const r of rows) {
    const v = videos.get(r.video_id) ?? { videoId: r.video_id, topic: r.topic, channelTitle: r.channel_title, comments: [] };
    videos.set(r.video_id, v);
    v.comments.push({
      id: r.cid, author: r.author_name, text: r.text, publishedIst: r.pub, status: r.status, needsEyes: r.needs_eyes, riskReasons: r.risk_reasons,
      reply: r.rid && r.rtext !== null ? { id: r.rid, text: r.rtext, status: r.rstatus ?? "held", error: r.rerror, seen: seenHash(r.text, r.rtext), wouldSend: r.would_send } : null,
    });
  }
  return {
    dryRun, killSwitch, lastSyncIst: sync.rows[0]?.ist ?? null, cap: policy.repliesPerDay, gapSeconds: policy.secondsBetweenReplies,
    used: used.rows.map((u) => ({ channelId: u.channel_id, title: u.title ?? u.channel_id, used: u.n })), videos: [...videos.values()],
  };
}
