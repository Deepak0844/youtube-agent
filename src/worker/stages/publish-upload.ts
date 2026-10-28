import type pg from "pg";
import type { UploadCaps } from "@/server/core/upload-rules";
import { UPLOAD_CAPS } from "@/server/core/publish-rules";
import { recordAudit } from "@/server/db/audit";
import { readUploadTarget, recheckPublishStart } from "@/server/db/publish";
import { runUpload } from "@/server/db/upload-job";
import { startUpload } from "@/server/db/uploads";
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

export async function handlePublishUpload(pool: pg.Pool, deps: PublishUploadDeps, uploadId: string): Promise<{ started: boolean }> {
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
  const started = await startUpload(
    pool, uploadId,
    { currentApprovalHash: value.approvalHash, currentFileSha: value.fileSha, caps: deps.caps ?? { ...UPLOAD_CAPS } },
    { recheck: (q, row) => recheckPublishStart(q, row) },
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
  return { started: true };
}
