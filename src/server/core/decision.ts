// Pure rules for a parked (needs_decision) stage (ADR 0004 section 8). No IO: the database half is db/decision.ts.
//
// A stage is parked when money may be held or spent and nobody knows (an open intent), when the budget refused a call, or
// when a call settled late. Only the signed-in owner picks what happens; this file says what the choices are and what the
// plain-language text is. The dollar figure is the reservation, i.e. the most that could have been charged.

import { microToUsd } from "./llm-catalog";

export const DECISION_CHOICES = ["release_and_rerun", "keep_spent_and_rerun", "cancel_video", "raise_cap_and_rerun", "use_result", "check_the_job"] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];
export const isDecisionChoice = (v: unknown): v is DecisionChoice => typeof v === "string" && (DECISION_CHOICES as readonly string[]).includes(v);

export type DecisionReason = "paid_call_may_have_run" | "budget_refused" | "settled_late";

export interface DecisionIntent {
  status: "pending" | "done" | "failed_known" | "unknown";
  reservedMicroUsd: number;
}

export interface DecisionView {
  /** The most the open (pending or unknown) calls could have cost: the sum of their reservations. */
  maxCostMicroUsd: number;
  reason: DecisionReason;
  summary: string;
  /** What the owner may choose for this stage, in the order to show them. */
  choices: readonly DecisionChoice[];
  /**
   * False when some call of this step already settled `done`: a fresh run (new call keys) would pay for it again, so
   * release/keep only settle the money and close the step, and the owner starts it again later on purpose.
   */
  rerunSafe: boolean;
}

const isOpen = (s: DecisionIntent["status"]): boolean => s === "pending" || s === "unknown";
const usd = (micro: number): string => `$${microToUsd(micro)}`;

function budgetRefused(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const t = (result as { needsDecision?: unknown }).needsDecision;
  return typeof t === "string" && t.startsWith("budget_refused");
}

/**
 * Why a stage is parked and what the owner may do. Safe by construction: a fresh rerun (new call keys) is offered only when
 * it cannot pay for the same work twice, i.e. when no call of the stage has settled `done`; a stage whose calls all settled
 * is offered "use the result" (same call keys, so nothing is paid again), and a stage that mixes both gets only cancel.
 */
export function describeDecision(
  stage: { name: string; status: string; result: unknown },
  intents: readonly DecisionIntent[],
  opts: { checkableJobs?: number } = {},
): DecisionView {
  const open = intents.filter((x) => isOpen(x.status));
  const done = intents.filter((x) => x.status === "done");
  const maxCostMicroUsd = open.reduce((sum, x) => sum + x.reservedMicroUsd, 0);

  if (open.length > 0) {
    const rerunSafe = done.length === 0;
    // "Check the job" only reads the provider's own record of a job we already hold; it is offered only when one is stored.
    const canCheck = (opts.checkableJobs ?? 0) > 0;
    return {
      maxCostMicroUsd,
      reason: "paid_call_may_have_run",
      summary:
        `A paid call in the "${stage.name}" step may have been charged and nobody knows for sure. The most it could have cost is ${usd(maxCostMicroUsd)}. ` +
        (canCheck ? "You can ask the provider about this job: nothing is paid or released by asking. Or check" : "Check") +
        ` the provider's billing page, then say whether it was charged. Nothing will run again until you choose.` +
        (rerunSafe ? "" : " Earlier calls in this step were already paid for, so this step will NOT be run again for you: your choice only settles the money and closes the step."),
      choices: canCheck ? ["check_the_job", "release_and_rerun", "keep_spent_and_rerun", "cancel_video"] : ["release_and_rerun", "keep_spent_and_rerun", "cancel_video"],
      rerunSafe,
    };
  }
  if (budgetRefused(stage.result)) {
    return {
      maxCostMicroUsd: 0,
      reason: "budget_refused",
      summary: `The "${stage.name}" step stopped because the next paid call would go over a spending limit. Nothing was charged for it. Raise the limit to carry on, or cancel the video.`,
      choices: ["raise_cap_and_rerun", "cancel_video"],
      rerunSafe: true,
    };
  }
  const allDone = intents.length > 0 && done.length === intents.length;
  if (allDone) {
    return {
      maxCostMicroUsd: 0,
      reason: "settled_late",
      summary: `Every paid call in the "${stage.name}" step finished and was paid for (${usd(done.reduce((s, x) => s + x.reservedMicroUsd, 0))} at most), but the step itself was not saved. Using the result carries on without paying again.`,
      choices: ["use_result", "cancel_video"],
      rerunSafe: true,
    };
  }
  const nothingPaid = done.length === 0;
  return {
    maxCostMicroUsd: 0,
    reason: "settled_late",
    summary: nothingPaid
      ? `The "${stage.name}" step stopped, but no paid call is outstanding. It can be run again.`
      : `The "${stage.name}" step stopped after some calls were paid for and others were not. Running it again could pay twice, so only cancelling is offered.`,
    choices: nothingPaid ? ["release_and_rerun", "cancel_video"] : ["cancel_video"],
    rerunSafe: nothingPaid,
  };
}
