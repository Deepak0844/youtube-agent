import type pg from "pg";
import { safeReason } from "@/server/core/paid-call";
import { finishUpload, reportProgress, startUpload, STUDIO_FIRST_PREFIX, type InternalOutcome, type StartCtx, type UploadOutcome } from "./uploads";

export interface UploadJobDeps {
  // Current approval hash / file sha / caps, read fresh at job time (never from the job payload).
  startCtx(uploadId: string): Promise<StartCtx> | StartCtx;
  uploader: {
    // onProgress throws UploadSupersededError (and aborts `signal`) when this attempt is no longer the live one:
    // the uploader must stop.
    upload(uploadId: string, onProgress: (bytesSent: number) => Promise<void>, signal: AbortSignal): Promise<UploadOutcome>;
  };
  // One JSON line per call; defaults to console.error. Used when recording the outcome fails twice.
  warn?(line: string): void;
  // Wait before the single retry of a failed DB call (default 200 ms).
  retryDelayMs?: number;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function retryOnce<T>(deps: UploadJobDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    await wait(deps.retryDelayMs ?? 200);
    return fn();
  }
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
  let outcome: InternalOutcome;
  try {
    const returned = await deps.uploader.upload(
      uploadId,
      async (bytes) => {
        if (!(await reportProgress(pool, uploadId, attempt, bytes))) {
          ac.abort();
          throw new UploadSupersededError();
        }
      },
      ac.signal,
    );
    // an uploader may only return the three public outcomes; anything else (incl. internal kinds) is a failure
    outcome = isPublicOutcome(returned) ? returned : { kind: "failed", reason: "uploader returned an invalid outcome" };
  } catch (err) {
    if (err instanceof UploadSupersededError || ac.signal.aborted) return; // normal stop: the row is no longer ours
    let sent: boolean;
    try {
      const { rows } = await retryOnce(deps, () =>
        pool.query<{ bytes_sent: string }>("select bytes_sent from uploads where id = $1 and attempt = $2 and status = 'uploading'", [uploadId, attempt]),
      );
      sent = rows[0] !== undefined && Number(rows[0].bytes_sent) > 0;
    } catch {
      sent = true; // cannot tell: assume bytes went out, so a human checks Studio first
    }
    // bytes already went out: the video may be live, so a human checks Studio first
    outcome = sent
      ? { kind: "failed_after_bytes", reason: safeReason(`${STUDIO_FIRST_PREFIX}${safeReason(err)}`) }
      : { kind: "failed", reason: safeReason(err) };
  }
  try {
    await retryOnce(deps, () => finishUpload(pool, uploadId, attempt, outcome));
  } catch (err) {
    // the DB is down: never lose the id of a video that may be live
    const youtubeId = (outcome.kind === "uploaded" || outcome.kind === "duplicate_skipped") && outcome.youtubeId ? safeReason(outcome.youtubeId) : null;
    const line = JSON.stringify({ event: "upload_job.finish_failed", uploadId, attempt, youtubeId, outcome: outcome.kind, error: safeReason(err) });
    (deps.warn ?? ((l: string) => console.error(l)))(line);
    throw err;
  }
}

function isPublicOutcome(o: unknown): o is UploadOutcome {
  const k = (o as { kind?: unknown } | null)?.kind;
  return k === "uploaded" || k === "duplicate_skipped" || k === "failed";
}
