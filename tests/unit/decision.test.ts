import { describe, expect, it } from "vitest";
import { describeDecision, DECISION_CHOICES, type DecisionIntent } from "@/server/core/decision";
import { isAuditEvent } from "@/server/core/audit-events";

const stage = (needsDecision = "reconciler: lease expired with a paid call of unknown outcome") => ({ name: "generate", status: "needs_decision", result: { needsDecision } });
const i = (status: DecisionIntent["status"], reservedMicroUsd: number): DecisionIntent => ({ status, reservedMicroUsd });

describe("describeDecision", () => {
  it("decision_text_names_the_maximum_dollar_amount", () => {
    const d = describeDecision(stage(), [i("unknown", 400_000), i("pending", 150_000), i("done", 9_000_000), i("failed_known", 7_000_000)]);
    expect(d.reason).toBe("paid_call_may_have_run");
    expect(d.maxCostMicroUsd).toBe(550_000); // only the open reservations, never done or released ones
    expect(d.summary).toContain("$0.55");
    expect(d.summary).toMatch(/may have been charged/i);
    expect(d.summary).not.toMatch(/intent|fence|reservation|call_key/i);
  });

  it("a_done_call_next_to_an_open_one_means_no_fresh_rerun_and_the_text_says_so", () => {
    const mixed = describeDecision(stage(), [i("done", 100_000), i("unknown", 400_000)]);
    expect(mixed.rerunSafe).toBe(false);
    expect(mixed.summary).toMatch(/will NOT be run again/);
    expect(describeDecision(stage(), [i("unknown", 400_000)]).rerunSafe).toBe(true);
    expect(describeDecision(stage(), [i("done", 1), i("failed_known", 1)]).rerunSafe).toBe(false);
  });

  it("a_zero_priced_open_call_still_asks_and_says_zero_dollars", () => {
    const d = describeDecision(stage(), [i("unknown", 0)]);
    expect(d.reason).toBe("paid_call_may_have_run");
    expect(d.summary).toContain("$0.00");
  });

  it("budget_refused_has_no_open_money_and_offers_raise_cap_and_cancel_only", () => {
    const d = describeDecision(stage("budget_refused: k"), []);
    expect(d.reason).toBe("budget_refused");
    expect(d.maxCostMicroUsd).toBe(0);
    expect(d.choices).toEqual(["raise_cap_and_rerun", "cancel_video"]);
  });

  it("open_money_wins_over_a_budget_refused_text", () => {
    const d = describeDecision(stage("budget_refused: k"), [i("unknown", 1_000_000)]);
    expect(d.reason).toBe("paid_call_may_have_run");
    expect(d.choices).toEqual(["release_and_rerun", "keep_spent_and_rerun", "cancel_video"]);
  });

  it("all_done_intents_offer_use_result_never_a_fresh_rerun_that_would_pay_again", () => {
    const d = describeDecision(stage(), [i("done", 100_000), i("done", 200_000)]);
    expect(d.reason).toBe("settled_late");
    expect(d.maxCostMicroUsd).toBe(0);
    expect(d.choices).toEqual(["use_result", "cancel_video"]);
  });

  it("done_mixed_with_failed_known_offers_only_cancel", () => {
    const d = describeDecision(stage(), [i("done", 100_000), i("failed_known", 100_000)]);
    expect(d.choices).toEqual(["cancel_video"]);
  });

  it("no_money_at_all_may_be_rerun_fresh", () => {
    expect(describeDecision(stage(), []).choices).toEqual(["release_and_rerun", "cancel_video"]);
    expect(describeDecision(stage(), [i("failed_known", 5)]).choices).toEqual(["release_and_rerun", "cancel_video"]);
  });

  it("the_choice_list_is_closed_and_the_audit_event_exists", () => {
    expect([...DECISION_CHOICES].sort()).toEqual(["cancel_video", "check_the_job", "keep_spent_and_rerun", "raise_cap_and_rerun", "release_and_rerun", "use_result"]);
    expect(isAuditEvent("stage.decision")).toBe(true);
    expect(isAuditEvent("stage.job_checked")).toBe(true);
  });
});

describe("check_the_job choice", () => {
  it("is_offered_first_only_when_an_open_call_has_a_stored_provider_job", () => {
    const withJob = describeDecision(stage(), [i("unknown", 400_000)], { checkableJobs: 1 });
    expect(withJob.choices).toEqual(["check_the_job", "release_and_rerun", "keep_spent_and_rerun", "cancel_video"]);
    expect(withJob.summary).toMatch(/ask the provider/i);
    expect(describeDecision(stage(), [i("unknown", 400_000)]).choices).not.toContain("check_the_job");
    expect(describeDecision(stage(), [i("done", 1)], { checkableJobs: 1 }).choices).not.toContain("check_the_job");
  });
  it("is_a_known_choice", () => {
    expect(DECISION_CHOICES).toContain("check_the_job");
  });
});
