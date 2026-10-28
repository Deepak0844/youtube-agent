import { describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { LeaseLostError, type PaidCallPorts } from "@/server/core/paid-call";
import { runStageWith, type StageClaim, type StageRunnerPorts } from "@/server/core/stage-runner";

const claim: StageClaim = { stageRunId: "s1", fence: 1, workerId: "w", leaseUntil: new Date(), jobId: "j" };
const paid: PaidCallPorts = {
  reserve: async () => ({ kind: "new", intentId: "i1" }), settle: async () => {}, failKnown: async () => {}, markUnknown: async () => {}, markStageNeedsDecision: async () => {}, warn: () => {},
};

// A fenced step (promote / save) refuses because the owner cancelled; the stage must end cancelled, not sit "running" until its lease runs out.
describe("stage runner: a fenced step refused because of a cancel", () => {
  function run(cancelAfterStart: boolean) {
    let cancelled = 0;
    const ports: StageRunnerPorts = {
      paid, claim: async () => claim, heartbeat: async () => true,
      getStage: async () => ({ id: "s1", name: "generate", inputHash: "h" }),
      cancelRequested: async () => cancelAfterStart,
      commit: async () => true, markNeedsDecision: async () => true, fail: async () => true,
      cancel: async () => { cancelled++; return "cancelled" as const; },
    };
    const out = runStageWith(ports, {
      provider: { call: async () => ({ result: 1, actualMicroUsd: 1 }) }, ttlMs: 60_000, workerId: "w", config: buildEngineConfig(new Map()),
      handler: async () => { throw new LeaseLostError("promote:s1"); },
    }, { stageRunId: "s1", inputHash: "h" });
    return { out, cancelled: () => cancelled };
  }
  it("ends_cancelled_when_the_owner_asked_for_it", async () => {
    const r = run(true);
    expect((await r.out).kind).toBe("cancelled");
    expect(r.cancelled()).toBe(1);
  });
  it("stays_lease_lost_when_nobody_cancelled", async () => {
    const r = run(false);
    expect((await r.out).kind).toBe("lease_lost");
    expect(r.cancelled()).toBe(0);
  });
});
