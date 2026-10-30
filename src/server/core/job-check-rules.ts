// Plain-language text for "check the job" (ADR 0004 section 8). Pure: no IO. The database half is db/job-check.ts.

export type CheckOutcome = "done" | "running" | "failed" | "unknown" | "already_done" | "nothing_to_check";

const TEXT: Record<CheckOutcome, string> = {
  done: "The provider finished the job. The result was saved and the money counted as spent. Use the result to carry on without paying again.",
  running: "The provider says the job is still running. Nothing changed and nothing was released. Check again in a minute.",
  failed: "The provider says the job failed or does not know it. Nothing was released: check the provider's billing page, then choose below.",
  unknown: "The provider's answer was unclear, so nothing changed and nothing was released. Check again later, or look at the provider's billing page.",
  already_done: "This job was already checked and settled. Nothing was charged again.",
  nothing_to_check: "There is no saved provider job to check for this step.",
};
export const checkMessage = (o: CheckOutcome): string => TEXT[o];
