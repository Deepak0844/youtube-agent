import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATES, GATE_IDS, GATE_ROADMAP_PHASE, gateById, type Gate, type GateId } from "@/server/core/gates";
import { SETTINGS } from "@/server/core/settings-registry";
import { GATE_SUITES, gatesWithoutSuite, suiteProblems, expectApprovalVoidedByChange, expectSessionRequired, expectStaleHashRejected, expectTokenCannotPass, type GateAct, type GateAttempt, type GateResult } from "../support/gate-invariants";

// Doc 02 4.4 as data, plus the registry rule: a gate row without a test suite (or an explicit todoPhase) fails the build.
describe("GATES (Doc 02 4.4)", () => {
  it("has exactly the eleven documented gates, once each", () => {
    expect([...GATE_IDS]).toEqual(["outline", "script", "cost", "chapter", "video", "thumbnail", "evidence", "publish", "comment_reply", "allow_public", "live_title"]);
    expect(new Set(GATES.map((g) => g.id)).size).toBe(GATES.length);
  });
  it("every gate is session-only and hash-bound, with a non-empty description of what the hash covers", () => {
    for (const g of GATES) {
      expect(g.approvedBy, g.id).toBe("session");
      expect(g.hashBound, g.id).toBe(true);
      expect(g.hashCovers.length, g.id).toBeGreaterThan(0);
      for (const c of g.hashCovers) expect(c.trim().length, g.id).toBeGreaterThan(0);
    }
  });
  it("the hash covers what Doc 02 4.4 lists for the money and publish gates", () => {
    expect(gateById("publish").hashCovers).toEqual(["video", "metadata", "evidence", "channel", "visibility", "publish_at"]);
    expect(gateById("cost").hashCovers).toEqual(["cost_plan", "providers_models", "path", "library_scene_versions", "quote"]);
    expect(gateById("allow_public").hashCovers).toEqual(["channel", "flag_value"]);
    expect(gateById("comment_reply").hashCovers).toEqual(["reply_text", "target_comment"]);
    expect(gateById("live_title").hashCovers).toEqual(["video", "new_title"]);
  });
  it("the table is deeply frozen so a phase cannot loosen a row at runtime", () => {
    expect(Object.isFrozen(GATES)).toBe(true);
    for (const g of GATES) {
      expect(Object.isFrozen(g), g.id).toBe(true);
      expect(Object.isFrozen(g.hashCovers), g.id).toBe(true);
    }
    expect(() => {
      (gateById("publish") as { approvedBy: string }).approvedBy = "token";
    }).toThrow();
  });
  it("allow_public is backed by a session-only safety setting", () => {
    expect(SETTINGS["policy.allow_public"].safety).toBe(true);
  });
  it("gateById refuses an unknown id", () => {
    expect(() => gateById("nope" as never)).toThrow(/unknown gate/);
  });
});

describe("gate suite registry", () => {
  it("every gate has a registered suite or an explicit todoPhase, and no suite names an unknown gate", () => {
    expect(gatesWithoutSuite(GATES, GATE_SUITES)).toEqual([]);
    expect(Object.keys(GATE_SUITES).sort()).toEqual([...GATE_IDS].sort());
  });
  it("a suite entry is a real file that imports the harness and runs its helpers for the gate; a todo equals the roadmap phase", () => {
    for (const [id, s] of Object.entries(GATE_SUITES)) {
      if ("suite" in s) {
        expect(existsSync(s.suite), `${id}: ${s.suite}`).toBe(true);
        expect(suiteProblems(id, readFileSync(s.suite, "utf8")), `${id}: ${s.suite}`).toEqual([]);
      } else {
        expect(s.todoPhase, `${id} todoPhase must equal GATE_ROADMAP_PHASE`).toBe(GATE_ROADMAP_PHASE[id as GateId]);
        expect(s.todoPhase, `${id} todoPhase`).toBeGreaterThanOrEqual(2);
      }
    }
  });
  it("the roadmap phase constant covers every gate", () => {
    expect(Object.keys(GATE_ROADMAP_PHASE).sort()).toEqual([...GATE_IDS].sort());
  });
  it("SELF-TEST: a suite file that only mentions the gate (no harness import, no helper call, no describe) is rejected", () => {
    expect(suiteProblems("publish", '// publish\nconst x = "publish";')).not.toEqual([]);
    expect(suiteProblems("publish", 'import { expectSessionRequired } from "../support/gate-invariants";\n// publish')).not.toEqual([]);
    const good = `import { describe, it } from "vitest";
import { expectSessionRequired, expectTokenCannotPass } from "../support/gate-invariants";
describe("publish gate", () => { it("x", async () => { await expectSessionRequired(gateById("publish"), act); await expectTokenCannotPass(gateById("publish"), act); }); });`;
    expect(suiteProblems("publish", good)).toEqual([]);
    expect(suiteProblems("cost", good)).not.toEqual([]); // wrong gate id
  });
  it("SELF-TEST: a new gate id without a suite fails the registry check", () => {
    const extra: Gate = Object.freeze({ id: "brand_new" as never, label: "x", hashCovers: Object.freeze(["x"]), approvedBy: "session", hashBound: true });
    expect(gatesWithoutSuite([...GATES, extra], GATE_SUITES)).toEqual(["brand_new"]);
    expect(gatesWithoutSuite([...GATES, extra], { ...GATE_SUITES, brand_new: { todoPhase: 5 } } as never)).toEqual([]);
    expect(gatesWithoutSuite([...GATES, extra], { ...GATE_SUITES, brand_new: {} } as never)).toEqual(["brand_new"]);
  });
});

// ---- the helpers must themselves be able to fail -------------------------------------------------------------------
interface FakeOpts {
  tokenPasses?: boolean;
  systemPasses?: boolean;
  ignoreHash?: boolean;
  survivesChange?: boolean;
  alwaysRefuse?: boolean;
  noReason?: boolean;
}
function fakeGate(o: FakeOpts = {}): { act: GateAct; mutate: () => Promise<void> } {
  let content = "v1";
  const seen = "v1";
  const no = (reason: string): GateResult => ({ ok: false, reason: o.noReason ? undefined : reason });
  const act: GateAct = async ({ actor, hash }: GateAttempt) => {
    if (o.alwaysRefuse) return no("never");
    if (actor === "token" && o.tokenPasses) return { ok: true };
    if (actor === "system" && o.systemPasses) return { ok: true };
    if (actor !== "session") return no("session required");
    const given = hash === "seen" ? seen : hash === "current" ? content : "stale-hash";
    if (!o.ignoreHash && !(o.survivesChange && hash === "seen") && given !== content) return no("content changed, review again");
    return { ok: true };
  };
  return {
    act,
    mutate: async () => {
      content = "v2";
    },
  };
}

describe("gate-invariants helpers (SELF-TEST against correct and broken gates)", () => {
  const gate = gateById("publish");
  it("accept a correct gate", async () => {
    const f = fakeGate();
    await expectSessionRequired(gate, f.act);
    await expectTokenCannotPass(gate, f.act);
    await expectStaleHashRejected(gate, f.act);
    const g = fakeGate();
    await expectApprovalVoidedByChange(gate, g.mutate, g.act);
  });
  it("expectTokenCannotPass catches a token that passes", async () => {
    await expect(expectTokenCannotPass(gate, fakeGate({ tokenPasses: true }).act)).rejects.toThrow();
  });
  it("expectSessionRequired catches a system actor that passes and a gate that refuses everyone", async () => {
    await expect(expectSessionRequired(gate, fakeGate({ systemPasses: true }).act)).rejects.toThrow();
    await expect(expectSessionRequired(gate, fakeGate({ alwaysRefuse: true }).act)).rejects.toThrow();
  });
  it("expectStaleHashRejected catches a gate that ignores the hash", async () => {
    await expect(expectStaleHashRejected(gate, fakeGate({ ignoreHash: true }).act)).rejects.toThrow();
  });
  it("expectApprovalVoidedByChange catches an approval that survives a change", async () => {
    const f = fakeGate({ survivesChange: true });
    await expect(expectApprovalVoidedByChange(gate, f.mutate, f.act)).rejects.toThrow();
  });
  it("a refusal without a reason is rejected (silent denial is not good enough)", async () => {
    await expect(expectTokenCannotPass(gate, fakeGate({ noReason: true }).act)).rejects.toThrow();
  });
});
