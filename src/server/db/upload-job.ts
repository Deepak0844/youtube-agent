import type pg from "pg";
import { safeReason } from "@/server/core/paid-call";
import { finishUpload, reportProgress, startUpload, type StartCtx, type UploadOutcome } from "./uploads";

export interface UploadJobDeps {
  // Current approval hash / file sha / caps, read fresh at job time (never from the job payload).
  startCtx(uploadId: string): Promise<StartCtx> | StartCtx;
  uploader: {
    upload(uploadId: string, onProgress: (bytesSent: number) => Promise<void>): Promise<UploadOutcome>;
  };
}

// Redelivery-safe: a job that does not win the start transition returns without touching YouTube.
// attempts is 1 and nothing re-runs this on failure: a crash leaves `uploading` until markStalled.
export async function handleUploadJob(pool: pg.Pool, deps: UploadJobDeps, uploadId: string): Promise<{ started: boolean }> {
  const started = await startUpload(pool, uploadId, await deps.startCtx(uploadId));
  if (!started.started) return { started: false };
  let outcome: UploadOutcome;
  try {
    outcome = await deps.uploader.upload(uploadId, async (bytes) => {
      await reportProgress(pool, uploadId, bytes);
    });
  } catch (err) {
    outcome = { kind: "failed", reason: safeReason(err) };
  }
  await finishUpload(pool, uploadId, outcome);
  return { started: true };
}
