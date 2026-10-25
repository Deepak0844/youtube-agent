import type { PaidCallPorts } from "@/server/core/paid-call";
import { failIntentKnown, markUnknown, reopenForRetry, reserveIntent, runTotalMicroUsd, settleIntent } from "./spend";
import { markStageNeedsDecision, type Claim, type Db } from "./stages";

// Postgres adapter for the paid-call wrapper. Every port call is its own transaction/statement.
export function createPgPaidCallPorts(db: Db): PaidCallPorts {
  return {
    reserve: (claim, args) => reserveIntent(db, claim as Claim, args),
    settle: async (intentId, args) => {
      await settleIntent(db, intentId, args);
    },
    failKnown: async (intentId, reason) => {
      await failIntentKnown(db, intentId, reason);
    },
    markUnknown: async (intentId) => {
      await markUnknown(db, intentId);
    },
    markStageNeedsDecision: async (claim, reason) => {
      await markStageNeedsDecision(db, claim as Claim, reason);
    },
    reopenForRetry: (intentId) => reopenForRetry(db, intentId),
    runTotalMicroUsd: (stageRunId) => runTotalMicroUsd(db, stageRunId),
  };
}
