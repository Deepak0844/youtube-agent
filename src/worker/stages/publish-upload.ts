import type pg from "pg";
import type { UploadCaps } from "@/server/core/upload-rules";
import { UPLOAD_CAPS } from "@/server/core/publish-rules";
import { recordAudit } from "@/server/db/audit";
import { channelCaps, readUploadTarget, recheckPublishStart } from "@/server/db/publish";
import { runUpload } from "@/server/db/upload-job";
import { isUnclearReason, manualRetry, startUpload } from "@/server/db/uploads";
import type { Uploader } from "@/server/providers/uploader";

// The `uploads` queue consumer's handler (Task 21). The job payload is ONLY an upload id. Everything that decides whether
// bytes may leave the machine is read here, at job time, from Postgres and the disk:
//   live approval hash + content versions (one repeatable-read snapshot) -> real file bytes hashed -> startUpload's
//   one-shot guarded transition compares them with what the owner approved -> only then the uploader runs.
// A refusal never retries and never touches the uploader. Redelivery finds the door used and does nothing.

export interface PublishUploadDeps {
  uploader: Uploader;
  root?: string;
  caps?: UploadCaps;
  /** Test seam: runs between the job-time read and the start transaction (to inject a send-back, a rewrite, a setting change). */
  afterRead?: () => Promise<void>;
}

const QUIET = new Set(["not_publish_approved", "not_found"]); // a duplicate delivery is normal, not news

// A human asked for a re-send (upload_log `retry_requested`, written by requestRetry after the owner confirmed). The same
// job-time proofs run as for a first send; a request is consumed by the transition (it only counts if newer than the failure).
async function handleRetry(pool: pg.Pool, deps: PublishUploadDeps, uploadId: string): Promise<{ started: boolean }> {
  const refused = async (reason: string): Promise<{ started: false }> => {
    await recordAudit(pool, "upload.retry_refused", { uploadId, reason }).catch(() => undefined);
    return { started: false };
  };
  const asked = await pool.query(
    "select 1 from upload_log l join uploads u on u.id = l.upload_id where l.upload_id = $1 and u.status = 'upload_failed' and l.event = 'retry_requested' and l.at > u.finished_at limit 1",
    [uploadId],
  );
  if (asked.rowCount !== 1) return refused("no_human_request");
  const t = await readUploadTarget(pool, uploadId, { root: deps.root, status: "upload_failed" });
  if (!t.ok) return refused(t.reason);
  const { value } = t;
  const base = deps.caps ?? { ...UPLOAD_CAPS };
  const started = await manualRetry(
    pool, uploadId,
    { currentApprovalHash: value.approvalHash, currentFileSha: value.fileSha, caps: base, humanConfirmedNotOnYouTube: true },
    { recheck: (q, row) => recheckPublishStart(q, row), capsFor: (q, channelId) => channelCaps(q, channelId, base) },
  );
  if (!started.started) return refused(started.reason);
  await recordAudit(pool, "upload.retry_started", { uploadId, videoId: value.target.videoId, approvalId: value.approvalId, attempt: started.attempt }).catch(() => undefined);
  await runUpload(
    pool,
    { startCtx: () => { throw new Error("startCtx is not used after the start"); }, uploader: { upload: (id, onProgress, signal) => deps.uploader.upload(id, onProgress, signal, value.target) } },
    uploadId,
    started.attempt,
  );
  await auditFinished(pool, uploadId);
  return { started: true };
}

/** One audit row for how the attempt ended (the upload row is the truth; no tokens, no session address). */
async function auditFinished(pool: pg.Pool, uploadId: string): Promise<void> {
  try {
    const r = (await pool.query<{ status: string; youtube_id: string | null; failure_reason: string | null }>("select status, youtube_id, failure_reason from uploads where id = $1", [uploadId])).rows[0];
    if (r) await recordAudit(pool, "upload.finished", { uploadId, status: r.status, youtubeId: r.youtube_id, unclear: isUnclearReason(r.failure_reason), reason: r.failure_reason });
  } catch {
    // the row already says how it ended
  }
}

export async function handlePublishUpload(pool: pg.Pool, deps: PublishUploadDeps, uploadId: string): Promise<{ started: boolean }> {
  if (typeof uploadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) return { started: false };
  const st = await pool.query<{ status: string }>("select status from uploads where id = $1", [uploadId]);
  if (st.rows[0]?.status === "upload_failed") return handleRetry(pool, deps, uploadId);
  const refused = async (reason: string, detail?: string): Promise<{ started: false }> => {
    if (!QUIET.has(reason)) {
      try {
        await recordAudit(pool, "upload.refused", { uploadId, reason, ...(detail ? { detail } : {}) });
      } catch {
        // the refusal itself already stopped the upload; a failed audit write must not turn into an upload
      }
    }
    return { started: false };
  };
  const t = await readUploadTarget(pool, uploadId, { root: deps.root });
  if (!t.ok) return refused(t.reason, t.detail);
  const { value } = t;
  await deps.afterRead?.();
  // The start transaction re-reads the live approval and policy after locking (recheckPublishStart): the snapshot above
  // is not trusted across the file hash.
  // The channel's own limits are re-read inside the start transaction (capsFor), so a limit lowered a moment ago applies.
  const base = deps.caps ?? { ...UPLOAD_CAPS };
  const started = await startUpload(
    pool, uploadId,
    { currentApprovalHash: value.approvalHash, currentFileSha: value.fileSha, caps: base },
    { recheck: (q, row) => recheckPublishStart(q, row), capsFor: (q, channelId) => channelCaps(q, channelId, base) },
  );
  if (!started.started) return refused(started.reason);
  try {
    await recordAudit(pool, "upload.started", {
      uploadId, videoId: value.target.videoId, approvalId: value.approvalId, hashPrefix: value.approvalHash.slice(0, 12),
      fileShaPrefix: value.fileSha.slice(0, 12), versions: value.versions, attempt: started.attempt,
    });
  } catch {
    // the row is already `uploading`; run it rather than strand a started upload over an audit hiccup
  }
  await runUpload(
    pool,
    {
      startCtx: () => {
        throw new Error("startCtx is not used after the start");
      },
      uploader: { upload: (id, onProgress, signal) => deps.uploader.upload(id, onProgress, signal, value.target) },
    },
    uploadId,
    started.attempt,
  );
  await auditFinished(pool, uploadId);
  return { started: true };
}
