import { runStageWith, type StageJob, type StageOutcome, type StageRunnerDeps } from "@/server/core/stage-runner";
import { createPgPaidCallPorts } from "./paid-call-adapter";
import { claimStage, commitStage, failStage, getStage, heartbeat, markStageNeedsDecision, type Claim, type Db } from "./stages";

// Postgres wiring for the worker body. Every port is its own statement/transaction (never settle+commit together).
export function runStage(db: Db, deps: StageRunnerDeps, job: StageJob): Promise<StageOutcome> {
  return runStageWith(
    {
      paid: createPgPaidCallPorts(db),
      claim: (args) => claimStage(db, args),
      heartbeat: (claim, ttlMs) => heartbeat(db, claim as Claim, ttlMs),
      getStage: async (id) => {
        const row = await getStage(db, id);
        return row && { id: row.id, name: row.name, inputHash: row.inputHash };
      },
      commit: (claim, result) => commitStage(db, claim as Claim, result),
      markNeedsDecision: (claim, reason) => markStageNeedsDecision(db, claim as Claim, reason),
      fail: (claim, reason) => failStage(db, claim as Claim, reason),
    },
    deps,
    job,
  );
}
