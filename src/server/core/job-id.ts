// The one source of truth for a stage attempt's queue job id: stage.<stageRunId>.<fence>.<attemptSeq>.
// Colon-free on purpose: BullMQ rejects custom ids containing ':' (except a legacy 3-part form it plans to drop).
// Unique per (stage, fence, attempt) so a re-enqueue is never swallowed by an existing (e.g. failed, kept) job.
export function stageJobId(stageRunId: string, fence: number, attemptSeq: number): string {
  if (stageRunId.length === 0 || /[.:]/.test(stageRunId)) throw new RangeError(`invalid stageRunId: ${stageRunId}`);
  for (const [name, v] of [["fence", fence], ["attemptSeq", attemptSeq]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${v}`);
  }
  return `stage.${stageRunId}.${fence}.${attemptSeq}`;
}
