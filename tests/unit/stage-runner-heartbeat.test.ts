import { describe, expect, it } from "vitest";
import { KnownFailure, type PaidCallPorts } from "@/server/core/paid-call";
import { runStageWith, type StageClaim, type StageRunnerDeps, type StageRunnerPorts } from "@/server/core/stage-runner";

const claim: StageClaim = { stageRunId: "s1", fence: 1, workerId: "w", leaseUntil: new Date(), jobId: "j" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Heartbeat fires every ttl/3 = 10 ms. The terminal port (commit / fail) is slow; every heartbeat that starts
// once the attempt has finished its work must be zero, or a finished attempt keeps extending a lease.
function setup(terminalMs: number) {
  let finished = false;
  let heartbeatsAfterFinish = 0;
  let heartbeatsBefore = 0;
  const paid: PaidCallPorts = {
    reserve: async () => ({ kind: "new", intentId: "i1" }),
    settle: async () => {},
    failKnown: async () => {},
    markUnknown: async () => {},
    markStageNeedsDecision: async () => {},
    warn: () => {},
  };
  const ports: StageRunnerPorts = {
    paid,
    claim: async () => claim,
    heartbeat: async () => {
      if (finished) heartbeatsAfterFinish++;
      else heartbeatsBefore++;
      return true;
    },
    getStage: async () => ({ id: "s1", name: "script", inputHash: "h" }),
    commit: async () => {
      finished = true;
      await sleep(terminalMs);
      return true;
    },
    markNeedsDecision: async () => true,
    fail: async () => {
      finished = true;
      await sleep(terminalMs);
      return true;
    },
  };
  return { ports, counts: () => ({ heartbeatsAfterFinish, heartbeatsBefore }) };
}

const step = { stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1, budgetScopes: ["g"], kind: "paid" as const };
const deps = (call: StageRunnerDeps["provider"]["call"]): StageRunnerDeps => ({
  provider: { call },
  ttlMs: 30,
  workerId: "w",
  stepsFor: () => [step],
});

describe("stage runner heartbeat", () => {
  it("heartbeat_after_attempt_finished_does_not_extend_lease (commit path)", async () => {
    const { ports, counts } = setup(120);
    const out = await runStageWith(ports, deps(async () => { await sleep(60); return { result: 1, actualMicroUsd: 1 }; }), { stageRunId: "s1", inputHash: "h" });
    expect(out.kind).toBe("committed");
    expect(counts().heartbeatsBefore).toBeGreaterThan(0); // it did beat while work ran
    expect(counts().heartbeatsAfterFinish).toBe(0);
  });

  it("heartbeat_after_attempt_finished_does_not_extend_lease (failure path)", async () => {
    const { ports, counts } = setup(120);
    const out = await runStageWith(ports, deps(async () => { await sleep(60); throw new KnownFailure("nope"); }), { stageRunId: "s1", inputHash: "h" });
    expect(out.kind).toBe("known_failure");
    expect(counts().heartbeatsAfterFinish).toBe(0);
  });
});
