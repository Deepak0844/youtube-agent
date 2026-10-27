import type { PaidCallPorts } from "@/server/core/paid-call";
import { runStageWith, type StageJob, type StageOutcome, type StageRunnerDeps } from "@/server/core/stage-runner";
import { createPgPaidCallPorts, type Warn } from "./paid-call-adapter";
import { cancelStage, claimStage, commitStage, failStage, getStage, heartbeat, markStageNeedsDecision, timeoutStage, type Claim, type Db } from "./stages";

// Postgres wiring for the worker body. Every port is its own statement/transaction (never settle+commit together).
// opts.paid: test seam to wrap the pg paid-call ports (e.g. simulate a failing reservation release).
export function runStage(
  db: Db,
  deps: StageRunnerDeps,
  job: StageJob,
  opts: { warn?: Warn; paid?: (base: PaidCallPorts) => PaidCallPorts } = {},
): Promise<StageOutcome> {
  const base = createPgPaidCallPorts(db, { warn: opts.warn });
  return runStageWith(
    {
      paid: opts.paid ? opts.paid(base) : base,
      claim: (args) => claimStage(db, args),
      heartbeat: (claim, ttlMs) => heartbeat(db, claim as Claim, ttlMs),
      cancelRequested: async (claim) => (await getStage(db, claim.stageRunId))?.cancelRequested === true,
      getStage: async (id) => {
        const row = await getStage(db, id);
        return row && { id: row.id, name: row.name, inputHash: row.inputHash };
      },
      commit: (claim, result) => commitStage(db, claim as Claim, result),
      markNeedsDecision: (claim, reason) => markStageNeedsDecision(db, claim as Claim, reason),
      fail: (claim, reason) => failStage(db, claim as Claim, reason),
      cancel: (claim) => cancelStage(db, claim as Claim),
      timeOut: (claim, reason) => timeoutStage(db, claim as Claim, reason),
    },
    deps,
    job,
  );
}
