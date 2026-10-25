import type { PaidCallPorts } from "@/server/core/paid-call";
import { failIntentKnown, markUnknown, reserveIntent, settleIntent } from "./spend";
import { markStageNeedsDecision, type Claim, type Db } from "./stages";

export type Warn = (event: string, detail: Record<string, unknown>) => void;

const defaultWarn: Warn = (event, detail) => console.warn(JSON.stringify({ level: "warn", event, ...detail }));

// Postgres adapter for the paid-call wrapper. Every port call is its own transaction/statement.
export function createPgPaidCallPorts(db: Db, opts: { warn?: Warn } = {}): PaidCallPorts {
  const warn = opts.warn ?? defaultWarn;
  return {
    warn,
    reserve: (claim, args) => reserveIntent(db, claim as Claim, args),
    settle: async (intentId, args) => {
      await settleIntent(db, intentId, args);
    },
    failKnown: async (intentId, reason) => {
      // false = the intent was no longer pending (e.g. another worker marked it unknown): its reservation stays held
      // for a human decision. Not an error, but never silent.
      if (!(await failIntentKnown(db, intentId, reason))) warn("paid_call.release_skipped_not_pending", { intentId });
    },
    markUnknown: async (intentId) => {
      await markUnknown(db, intentId);
    },
    markStageNeedsDecision: async (claim, reason) => {
      await markStageNeedsDecision(db, claim as Claim, reason);
    },
  };
}
