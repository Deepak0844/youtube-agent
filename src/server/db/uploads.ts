import pg from "pg";
import { checkUploadPreconditions, assertUploadCaps, type UploadCaps } from "@/server/core/upload-rules";
import { safeReason } from "@/server/core/paid-call";
import { atomic, toNumber, type Db } from "./stages";

// One-shot YouTube upload transition. A public upload cannot be undone, so Postgres decides, once:
//   publish_approved -> uploading -> uploaded | upload_failed        (startUpload / reportProgress / finishUpload)
//   uploading -> upload_failed when progress stalls                  (markStalled; NEVER requeues)
//   upload_failed -> uploading ONLY by a human                       (manualRetry; there is no automatic retry path)
// Every transition is a conditional UPDATE guarded by the current status, and the partial unique index
// uploads_one_active_per_video (one uploading/uploaded row per video) is the last line of defence.
// All times come from the DATABASE clock. Quota simplification: the schema has no per-upload cost column, so quota
// used today = (uploads started today on the channel) x caps.costUnits.
// EVERY row with started_at set counts (including upload_failed): a failed row may be live on YouTube and YouTube
// charges quota for failed inserts. "Today" is the America/Los_Angeles calendar day, because YouTube quota resets
// at midnight Pacific.
// LOCK ORDER (always): the video's rows by id (row + siblings, FOR UPDATE) -> the channel advisory lock -> counts ->
// conditional UPDATE. Locking the siblings makes a start wait for a concurrent markStalled/finish of a sibling and
// then see its committed state (READ COMMITTED); nothing else may take these locks in another order.
// ATTEMPT TOKEN: every start/manual retry bumps uploads.attempt; progress and finish must present the current
// attempt while `uploading`, so a leftover uploader from a stalled attempt can never touch a newer one.

export type StartCtx = { currentApprovalHash: string; currentFileSha: string; caps: UploadCaps };
// ignoreLoggedYoutubeId: a human cleared a youtube id that exists only in upload_log (a rejected stale attempt).
export type RetryCtx = StartCtx & { humanConfirmedNotOnYouTube: true; ignoreLoggedYoutubeId?: true };
export type StartResult = { started: true; attempt: number } | { started: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assertId(id: string): void {
  if (typeof id !== "string" || !UUID.test(id)) throw new RangeError(`invalid upload id: ${String(id)}`);
}
const INT4_MAX = 2147483647; // uploads.attempt is int4
function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt > INT4_MAX) throw new RangeError(`attempt must be an integer in [0, ${INT4_MAX}], got ${attempt}`);
}
function assertCtx(ctx: StartCtx): void {
  if (typeof ctx.currentApprovalHash !== "string" || ctx.currentApprovalHash === "") throw new RangeError("currentApprovalHash required");
  if (typeof ctx.currentFileSha !== "string" || ctx.currentFileSha === "") throw new RangeError("currentFileSha required");
  assertUploadCaps(ctx.caps);
}

interface LockedRow {
  id: string;
  status: string;
  started_at: Date | null;
  video_id: string;
  approval_hash: string | null;
  file_sha: string | null;
  channel_id: string | null;
  youtube_id: string | null;
}

// A log event that carries a youtube id in the parseable token form `youtube_id=<id>`.
const LOGGED_YT_ID = "'^(finish_rejected|late_success_conflict|late_success)[: ].*youtube_id=[^[:space:]]'";
// Token form of an id for the log: trimmed and percent-encoded (never contains a space); null when blank.
const ytToken = (id: string): string | null => {
  const t = safeReason(id).trim();
  return t === "" ? null : `youtube_id=${encodeURIComponent(t)}`;
};

const PACIFIC_DAY_START = "(date_trunc('day', clock_timestamp() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles')";

// Caps: daily cap and spacing look at OTHER rows only; a retry is the same upload (and a human confirmed it), so the
// row being started/retried never blocks itself. Quota counts EVERY attempt, the row's own earlier attempts
// included, because YouTube charges quota per insert attempt: quotaUsedToday = sum(attempt) over today's started
// rows x costUnits.
// Shared guarded transition `from` -> uploading, used by BOTH startUpload (publish_approved) and manualRetry
// (upload_failed): same lock order, same precondition evaluation, same conditional UPDATE. Runs at READ COMMITTED:
// the advisory lock only serialises channel starts if the counts read AFTER the lock see the previous holder's commit.
async function guardedStart(
  db: Db,
  uploadId: string,
  ctx: StartCtx & { ignoreLoggedYoutubeId?: true },
  from: "publish_approved" | "upload_failed",
): Promise<StartResult> {
  assertId(uploadId);
  assertCtx(ctx);
  const wrongStatus = from === "publish_approved" ? "not_publish_approved" : "not_upload_failed";
  try {
    return await atomic(
      db,
      async (q) => {
        const iso = await q.query<{ iso: string }>("select current_setting('transaction_isolation') as iso");
        if (iso.rows[0]!.iso !== "read committed") return { started: false, reason: "isolation_not_read_committed" } as const;

        // 1. lock the row AND its siblings (same video) in id order; whatever a redelivery, a concurrent starter or a
        //    concurrent markStalled/finish did is decided here (we wait for it and see the committed state)
        const vid = await q.query<{ video_id: string }>("select video_id from uploads where id = $1", [uploadId]);
        if (vid.rowCount === 0) return { started: false, reason: "not_found" } as const;
        const { rows: locked } = await q.query<LockedRow>(
          `select id, status, started_at, video_id, approval_hash, file_sha, channel_id, youtube_id
             from uploads where video_id = $1 order by id for update`,
          [vid.rows[0]!.video_id],
        );
        const row = locked.find((r) => r.id === uploadId);
        if (!row) return { started: false, reason: "not_found" } as const;
        const siblings = locked.filter((r) => r.id !== uploadId);
        if (row.status !== from) return { started: false, reason: wrongStatus } as const;
        if (row.approval_hash === null) return { started: false, reason: "approval_changed" } as const;
        if (row.file_sha === null) return { started: false, reason: "file_changed" } as const;
        if (row.channel_id === null) return { started: false, reason: "no_channel" } as const;
        if (from === "upload_failed" && row.youtube_id !== null) return { started: false, reason: "already_on_youtube" } as const;

        // a sibling that failed after starting (may be live) or already has a video id: a human resolves it
        if (siblings.some((r) => (r.status === "upload_failed" && r.started_at !== null) || r.youtube_id !== null)) {
          return { started: false, reason: "unresolved_sibling_upload" } as const;
        }
        // a video id known only from the log (a rejected stale attempt) also blocks; a human may clear their OWN row's
        const ids = ctx.ignoreLoggedYoutubeId === true ? siblings.map((r) => r.id) : locked.map((r) => r.id);
        const logged = await q.query(`select 1 from upload_log where upload_id = any($1::uuid[]) and event ~ ${LOGGED_YT_ID} limit 1`, [ids]);
        if (logged.rowCount !== 0) return { started: false, reason: "youtube_id_known_in_log" } as const;

        // 2. serialise every start on this channel so caps/spacing/quota cannot be raced by a sibling video
        await q.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [row.channel_id]);
        const { rows: stat } = await q.query<{ n: string; last: Date | null; attempts: string; now: Date }>(
          `select count(*) filter (where started_at >= ${PACIFIC_DAY_START} and id <> $2) as n,
                  max(started_at) filter (where id <> $2) as last,
                  coalesce(sum(greatest(attempt, 1)) filter (where started_at >= ${PACIFIC_DAY_START}), 0) as attempts,
                  clock_timestamp() as now
             from uploads
            where channel_id = $1 and started_at is not null`,
          [row.channel_id, uploadId],
        );
        const s = stat[0]!;
        const uploadsToday = toNumber(s.n);
        const verdict = checkUploadPreconditions({
          approvalHash: row.approval_hash,
          currentApprovalHash: ctx.currentApprovalHash,
          fileSha: row.file_sha,
          currentFileSha: ctx.currentFileSha,
          caps: ctx.caps,
          uploadsToday,
          lastUploadAt: s.last,
          quotaUsedToday: toNumber(s.attempts) * ctx.caps.costUnits,
          now: s.now,
        });
        if (!verdict.ok) return { started: false, reason: verdict.reason } as const;

        // 3. the conditional transition; bumping attempt invalidates every earlier uploader
        const res = await q.query<{ attempt: number }>(
          `update uploads
              set status = 'uploading', attempt = attempt + 1, started_at = clock_timestamp(),
                  last_progress_at = clock_timestamp(), bytes_sent = 0, finished_at = null, failure_reason = null,
                  updated_at = clock_timestamp()
            where id = $1 and status = $2
        returning attempt`,
          [uploadId, from],
        );
        if (res.rowCount !== 1) return { started: false, reason: wrongStatus } as const;
        await q.query("insert into upload_log (upload_id, event) values ($1, $2)", [
          uploadId,
          from === "publish_approved" ? "started" : "manual_retry",
        ]);
        return { started: true, attempt: res.rows[0]!.attempt } as const;
      },
      { isolation: "read committed" },
    );
  } catch (err) {
    // another uploading/uploaded row for this video: the partial unique index refused
    if ((err as { code?: string }).code === "23505") return { started: false, reason: "another_upload_active_for_video" };
    throw err;
  }
}

export function startUpload(db: Db, uploadId: string, ctx: StartCtx): Promise<StartResult> {
  // override flags belong to manualRetry only: strip them even if a caller passes them at runtime
  const clean: Record<string, unknown> = { ...ctx };
  delete clean.ignoreLoggedYoutubeId;
  delete clean.humanConfirmedNotOnYouTube;
  return guardedStart(db, uploadId, clean as StartCtx, "publish_approved");
}

// The ONLY function that moves upload_failed -> uploading. Human-initiated: the caller must state that a human
// checked YouTube Studio and the video is not there. The returned attempt must be handed to runUpload.
export async function manualRetry(db: Db, uploadId: string, ctx: RetryCtx): Promise<StartResult> {
  assertId(uploadId);
  if ((ctx as { humanConfirmedNotOnYouTube?: unknown }).humanConfirmedNotOnYouTube !== true) {
    return { started: false, reason: "human_confirmation_required" };
  }
  const ignore = (ctx as { ignoreLoggedYoutubeId?: unknown }).ignoreLoggedYoutubeId === true;
  return guardedStart(db, uploadId, { ...ctx, ...(ignore ? { ignoreLoggedYoutubeId: true as const } : { ignoreLoggedYoutubeId: undefined }) }, "upload_failed");
}

// Monotonic and bounded: a lower value than recorded, a value above bytes_total, or a stale attempt is ignored (false).
export async function reportProgress(db: Db, uploadId: string, attempt: number, bytesSent: number): Promise<boolean> {
  assertId(uploadId);
  assertAttempt(attempt);
  if (!Number.isSafeInteger(bytesSent) || bytesSent < 0) throw new RangeError(`bytesSent must be a non-negative safe integer, got ${bytesSent}`);
  const res = await db.query(
    `update uploads set bytes_sent = $3::bigint, last_progress_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = $1 and status = 'uploading' and attempt = $2
        and bytes_sent <= $3::bigint and (bytes_total is null or $3::bigint <= bytes_total)`,
    [uploadId, attempt, String(bytesSent)],
  );
  return res.rowCount === 1;
}

export type UploadOutcome =
  | { kind: "uploaded"; youtubeId: string }
  | { kind: "duplicate_skipped"; youtubeId?: string }
  | { kind: "failed"; reason: string };
// Produced only by runUpload when the uploader threw after bytes were sent; never accepted from an uploader.
export type InternalOutcome = UploadOutcome | { kind: "failed_after_bytes"; reason: string };

export const DUPLICATE_SKIPPED_REASON = "duplicate_skipped: check YouTube Studio";
export const STALLED_REASON = "no progress: check YouTube Studio first";
export const STUDIO_FIRST_PREFIX = "check YouTube Studio first: ";
// Failure reasons that make a stalled/failed attempt eligible for a late success. Reserved: matched EXACTLY, and an
// uploader-supplied reason can never produce them (it gets a neutral prefix).
const isLateSuccessReason = (r: string | null): boolean => r !== null && (r === STALLED_REASON || r.startsWith(STUDIO_FIRST_PREFIX));
const isReservedReason = (r: unknown): boolean => {
  const c = safeReason(String(r));
  return c === STALLED_REASON || c.startsWith("check YouTube Studio first");
};

const withToken = (prefix: string, id: string | undefined): string => {
  const tok = id === undefined ? null : ytToken(id);
  return tok ? `${prefix} ${tok}` : prefix;
};

// Only from `uploading` with the current attempt. "duplicate skipped" is a FAILURE: we cannot tell which video
// YouTube kept. A successful upload that arrives after its row was stalled (same attempt) is recorded, not dropped.
// Every false return logs finish_rejected (with the youtube id when given): a live video's id is never lost.
export async function finishUpload(db: Db, uploadId: string, attempt: number, outcome: InternalOutcome): Promise<boolean> {
  assertId(uploadId);
  assertAttempt(attempt);
  if (outcome.kind === "uploaded" && (typeof outcome.youtubeId !== "string" || outcome.youtubeId === "")) {
    throw new RangeError("youtubeId required");
  }
  return atomic(db, async (q) => {
    const iso = await q.query<{ iso: string }>("select current_setting('transaction_isolation') as iso");
    if (iso.rows[0]!.iso !== "read committed") throw new Error("finishUpload requires a READ COMMITTED transaction");
    const log = (event: string) => q.query("insert into upload_log (upload_id, event) values ($1, $2)", [uploadId, event]);
    let res: pg.QueryResult;
    let event: string;
    if (outcome.kind === "uploaded") {
      res = await q.query(
        `update uploads set status = 'uploaded', youtube_id = $3, finished_at = clock_timestamp(), updated_at = clock_timestamp()
          where id = $1 and status = 'uploading' and attempt = $2`,
        [uploadId, attempt, safeReason(outcome.youtubeId)],
      );
      event = "uploaded";
    } else {
      const reason =
        outcome.kind === "duplicate_skipped"
          ? DUPLICATE_SKIPPED_REASON
          : outcome.kind === "failed_after_bytes"
            ? safeReason(outcome.reason)
            : isReservedReason(outcome.reason)
              ? safeReason(`uploader said: ${safeReason(String(outcome.reason))}`)
              : safeReason(String(outcome.reason));
      const yt = outcome.kind === "duplicate_skipped" && outcome.youtubeId ? safeReason(outcome.youtubeId) : null;
      res = await q.query(
        `update uploads set status = 'upload_failed', failure_reason = $3, youtube_id = coalesce($4, youtube_id),
                finished_at = clock_timestamp(), updated_at = clock_timestamp()
          where id = $1 and status = 'uploading' and attempt = $2`,
        [uploadId, attempt, reason, yt],
      );
      event = outcome.kind;
    }
    if (res.rowCount === 1) {
      await log(event);
      return true;
    }

    // Not the live attempt. A late success of a stalled attempt is the one case we can still honour.
    if (outcome.kind === "uploaded") {
      const youtubeId = safeReason(outcome.youtubeId);
      const { rows } = await q.query<{ status: string; failure_reason: string | null; attempt: number; youtube_id: string | null }>(
        "select status, failure_reason, attempt, youtube_id from uploads where id = $1 for update",
        [uploadId],
      );
      const r = rows[0];
      if (r && r.status === "upload_failed" && r.attempt === attempt && r.youtube_id === null && isLateSuccessReason(r.failure_reason)) {
        await q.query("savepoint late_success");
        try {
          const late = await q.query(
            `update uploads set status = 'uploaded', youtube_id = $2, failure_reason = null, finished_at = clock_timestamp(), updated_at = clock_timestamp()
              where id = $1 and status = 'upload_failed' and attempt = $3 and youtube_id is null`,
            [uploadId, youtubeId, attempt],
          );
          if (late.rowCount === 1) {
            await q.query("release savepoint late_success");
            await log(withToken("late_success", youtubeId));
            return true;
          }
          await q.query("release savepoint late_success");
        } catch (err) {
          await q.query("rollback to savepoint late_success");
          if ((err as { code?: string }).code !== "23505") throw err;
          // a sibling row went active: keep upload_failed but never lose the video id
          await q.query("update uploads set youtube_id = $2, updated_at = clock_timestamp() where id = $1 and youtube_id is null", [uploadId, youtubeId]);
          await log(withToken("late_success_conflict", youtubeId));
        }
      }
    }
    const yt = outcome.kind === "uploaded" ? outcome.youtubeId : outcome.kind === "duplicate_skipped" ? outcome.youtubeId : undefined;
    await log(withToken(`finish_rejected: kind=${outcome.kind} attempt=${attempt}`, yt));
    return false;
  }, { isolation: "read committed" });
}

// `uploading` rows with no progress for noProgressMs (DB clock) become upload_failed. Never requeues or retries:
// the upload may have reached YouTube, so a human checks Studio first.
export async function markStalled(db: Db, noProgressMs: number): Promise<string[]> {
  if (!Number.isSafeInteger(noProgressMs) || noProgressMs < 1) throw new RangeError(`noProgressMs must be a positive safe integer, got ${noProgressMs}`);
  return atomic(db, async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `update uploads
          set status = 'upload_failed', failure_reason = $2, finished_at = clock_timestamp(), updated_at = clock_timestamp()
        where status = 'uploading'
          and coalesce(last_progress_at, started_at) < clock_timestamp() - make_interval(secs => $1::double precision / 1000.0)
    returning id`,
      [noProgressMs, STALLED_REASON],
    );
    for (const r of rows) await q.query("insert into upload_log (upload_id, event) values ($1, 'stalled')", [r.id]);
    return rows.map((r) => r.id);
  });
}
