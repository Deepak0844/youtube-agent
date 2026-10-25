import type pg from "pg";
import { safeReason } from "@/server/core/paid-call";
import { finishUpload, reportProgress, startUpload, type StartCtx, type UploadOutcome } from "./uploads";

export interface UploadJobDeps {
  // Current approval hash / file sha / caps, read fresh at job time (never from the job payload).
  startCtx(uploadId: string): Promise<StartCtx> | StartCtx;
  uploader: {
    // onProgress throws UploadSupersededError (and aborts `signal`) when this attempt is no longer the live one:
    // the uploader must stop.
    upload(uploadId: string, onProgress: (bytesSent: number) => Promise<void>, signal: AbortSignal): Promise<UploadOutcome>;
  };
}

export class UploadSupersededError extends Error {
  constructor() {
    super("upload attempt superseded");
    this.name = "UploadSupersededError";
  }
}

// Redelivery-safe: a job that does not win the start transition returns without touching YouTube.
// attempts is 1 and nothing re-runs this on failure: a crash leaves `uploading` until markStalled.
export async function handleUploadJob(pool: pg.Pool, deps: UploadJobDeps, uploadId: string): Promise<{ started: boolean }> {
  const started = await startUpload(pool, uploadId, await deps.startCtx(uploadId));
  if (!started.started) return { started: false };
  await runUpload(pool, deps, uploadId, started.attempt);
  return { started: true };
}

// Runs the uploader for an ALREADY-STARTED attempt (from startUpload or manualRetry). Progress and finish carry the
// attempt token, so a stale executor cannot write; a rejected progress report aborts the uploader.
export async function runUpload(pool: pg.Pool, deps: UploadJobDeps, uploadId: string, attempt: number): Promise<void> {
  const ac = new AbortController();
  let outcome: UploadOutcome;
  try {
    outcome = await deps.uploader.upload(
      uploadId,
      async (bytes) => {
        if (!(await reportProgress(pool, uploadId, attempt, bytes))) {
          ac.abort();
          throw new UploadSupersededError();
        }
      },
      ac.signal,
    );
  } catch (err) {
    if (err instanceof UploadSupersededError || ac.signal.aborted) return; // normal stop: the row is no longer ours
    const { rows } = await pool.query<{ bytes_sent: string }>(
      "select bytes_sent from uploads where id = $1 and attempt = $2 and status = 'uploading'",
      [uploadId, attempt],
    );
    const sent = rows[0] !== undefined && Number(rows[0].bytes_sent) > 0;
    // bytes already went out: the video may be live, so a human checks Studio first
    outcome = { kind: "failed", reason: sent ? safeReason(`check YouTube Studio first: ${safeReason(err)}`) : safeReason(err) };
  }
  await finishUpload(pool, uploadId, attempt, outcome);
}
