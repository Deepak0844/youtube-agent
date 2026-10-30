import { KnownFailure } from "@/server/core/paid-call";
import { NotProcessedError } from "@/server/core/error-class";
import type { StageContext } from "@/server/core/stage-handler";
import type { Db } from "@/server/db/stages";
import { finishJob, markJobFailedKnown, markJobUnknown, storeProviderJobId, submitOnce } from "@/server/db/media-jobs";
import type { MediaArtifact } from "./media-types";

export interface AsyncMediaDeps {
  db: Db;
  provider: string;
  kind: string;
  /** The paid call's step index (from its call key): with the stage run it identifies the media_jobs row. */
  step: number;
  quoteMicroUsd: number;
  signal: AbortSignal;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface AsyncMediaSteps {
  /** Returns the provider's job id. */
  submit(): Promise<string>;
  /** null = not finished yet; otherwise whatever download() needs (a URL). */
  poll(jobId: string): Promise<string | null>;
  download(ref: string): Promise<Buffer>;
  save(bytes: Buffer): Promise<MediaArtifact>;
}

const MIN_POLL_MS = 2000;
const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** The step index inside a paid-call key (`stageRunId:step:toolCall`). */
export const stepOfKey = (key: string): number => Number(key.split(":").at(-2));

/**
 * Submit once, store the provider job id, poll, download. The job row is written BEFORE the submit. A resume with a stored id only
 * polls; a row still in `submitting` means a submit may have gone out and its id was lost: unknown, never resubmitted.
 * Polls start at 2 s and follow the engine back-off (never below 2 s). Cancel stops the loop and leaves the row as it is.
 */
export async function runAsyncMedia(ctx: StageContext, d: AsyncMediaDeps, s: AsyncMediaSteps): Promise<MediaArtifact> {
  const { job, created } = await submitOnce(d.db, { stageRunId: ctx.claim.stageRunId, step: d.step }, d.provider, d.kind, d.quoteMicroUsd);
  if (job.provider !== d.provider || job.kind !== d.kind) throw new Error("This step already holds a job from another provider; it needs the owner's decision.");
  if (job.state === "done" && job.artifact) return job.artifact;
  if (job.state === "failed_known") throw new KnownFailure("The provider refused this job earlier. Nothing was charged.");
  if (job.state === "unknown") throw new Error("This job's outcome is unknown; it needs the owner's decision.");

  let jobId = job.providerJobId;
  if (job.state === "submitting") {
    if (!created) {
      await markJobUnknown(d.db, job.id);
      throw new Error("A submit was started but its job id was never stored; the outcome is unknown and it needs the owner's decision.");
    }
    try {
      jobId = await s.submit();
    } catch (err) {
      if (err instanceof NotProcessedError) await markJobFailedKnown(d.db, job.id);
      else await markJobUnknown(d.db, job.id);
      throw err;
    }
    if (!(await storeProviderJobId(d.db, job.id, jobId))) throw new Error("The provider job id could not be stored; the outcome is unknown.");
  }

  try {
    const delays = [2, ...ctx.config.retryBackoffSeconds];
    const sleep = d.sleep ?? abortableSleep;
    let ref: string | null;
    for (let i = 0; (ref = await s.poll(jobId!)) === null; i++) await sleep(Math.max(MIN_POLL_MS, delays[Math.min(i, delays.length - 1)]! * 1000), d.signal);
    const artifact = await s.save(await s.download(ref));
    await finishJob(d.db, job.id, { actual: d.quoteMicroUsd, artifact });
    return artifact;
  } catch (err) {
    // The job exists and may bill: a refusal-looking error here must not release the reservation.
    if (err instanceof KnownFailure) throw new Error(err.message);
    throw err;
  }
}
