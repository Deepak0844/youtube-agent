// What a stored media file records about itself. `quoted` is true when priceMicroUsd is our quote, false when the provider reported it.
export type MediaArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  durationS?: number;
  width?: number;
  height?: number;
  provenance: {
    provider: string;
    model?: string;
    params: Record<string, unknown>;
    priceMicroUsd: number;
    quoted: boolean;
    licence?: string;
    sourceUrl?: string;
    attribution?: string;
  };
};

/** What a read-only look at a stored provider job found. `failed` = the provider clearly says the job failed or does not know it. Anything unclear is `unknown`. */
export type JobOutcome = { kind: "done"; artifact: MediaArtifact } | { kind: "running" } | { kind: "failed"; reason: string } | { kind: "unknown" };

/** Asks a provider about a job it already holds. Read only: never submits, never reserves. `done` has already stored the file (content-addressed). */
export interface JobChecker {
  check(job: { providerJobId: string; quoteMicroUsd: number }): Promise<JobOutcome>;
}
export type JobCheckers = Readonly<Record<string, JobChecker>>;
