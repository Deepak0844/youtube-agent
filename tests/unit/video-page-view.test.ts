import { describe, expect, it } from "vitest";
import { estimateLabel, fmtDuration, headline, median, parseFindings, parseTab, rerunCostNote, rerunOffered, stageViews, TABS, type RunFact } from "@/server/core/video-page-view";

const run = (o: Partial<RunFact>): RunFact => ({ status: "succeeded", createdAt: 0, updatedAt: 0, retryNumber: 0, error: null, percent: null, ...o });
const plan = ["draft", "build", "tts", "render"] as const;
const base = { plan: [...plan], gates: { draft: { gate: "script" as const, when: "after" as const } }, openGate: null, estimates: {}, maxTries: 10, now: 100_000 };

describe("parseTab", () => {
  it("defaults to script and ignores junk", () => {
    expect(parseTab(undefined)).toBe("script");
    expect(parseTab("nope")).toBe("script");
    expect(parseTab(["cost", "log"])).toBe("cost");
    expect(parseTab("qa")).toBe("qa");
    expect(TABS.map((t) => t.id)).toEqual(["script", "beats", "evidence", "titles", "cost", "qa", "audit", "log"]);
  });
});

describe("median / estimate", () => {
  it("needs at least 3 samples, never invents", () => {
    expect(median([])).toBeNull();
    expect(median([5, 9])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
    expect(estimateLabel(null)).toBe("no estimate yet");
    expect(estimateLabel(125_000)).toBe("about 2 min");
  });
  it("formats durations", () => {
    expect(fmtDuration(4_000)).toBe("4 s");
    expect(fmtDuration(90 * 60_000)).toBe("1 h 30 min");
  });
});

describe("stageViews", () => {
  it("maps run statuses to the five plain states", () => {
    const v = stageViews({ ...base, runs: { draft: run({}), build: run({ status: "running", createdAt: 40_000 }), tts: run({ status: "failed", error: "boom" }) }, estimates: { build: 100_000 } });
    expect(v.map((s) => s.state)).toEqual(["done", "running", "failed", "pending"]);
    expect(v[1]!.timeLeft).toBe("about 40 s left");
    expect(v[2]!.detail).toBe("boom");
    expect(v[3]!.detail).toBe("Not started");
  });
  it("shows percent and retry in plain words", () => {
    const v = stageViews({ ...base, runs: { render: run({ status: "running", percent: 40 }), tts: run({ status: "queued", retryNumber: 2 }) } });
    expect(v[3]!.detail).toBe("Rendering 40%");
    expect(v[3]!.percent).toBe(40);
    expect(v[2]!.state).toBe("running");
    expect(v[2]!.detail).toBe("Waiting on the provider, retry 2 of 10");
  });
  it("marks the stage whose gate is open as needs you", () => {
    const v = stageViews({ ...base, runs: { draft: run({}) }, openGate: "script" });
    expect(v[0]!.state).toBe("needs_you");
    expect(v[0]!.detail).toBe("Waiting for your OK on the script");
    expect(headline(v, "waiting")).toBe("Waiting for you: Draft");
  });
  it("treats parked and cancelled runs honestly", () => {
    const v = stageViews({ ...base, runs: { draft: run({ status: "needs_decision" }), build: run({ status: "cancelled" }) } });
    expect(v[0]!.state).toBe("needs_you");
    expect(v[1]!.state).toBe("failed");
    expect(v[1]!.detail).toBe("Cancelled");
  });
});

describe("rerun", () => {
  it("is offered only for a failed or cancelled stage of a live video", () => {
    expect(rerunOffered("failed", "active")).toBe(true);
    expect(rerunOffered("cancelled", "waiting")).toBe(true);
    expect(rerunOffered("succeeded", "active")).toBe(false);
    expect(rerunOffered("failed", "cancelled")).toBe(false);
    expect(rerunOffered(undefined, "active")).toBe(false);
  });
  it("states the cost only from the cost plan", () => {
    expect(rerunCostNote("generate", 2_500_000)).toBe("Costs up to $2.50 (the cost plan's paid items).");
    expect(rerunCostNote("generate", null)).toBe("No paid items in the cost plan.");
    expect(rerunCostNote("render", 2_500_000)).toBe("Not part of the cost plan: no paid items.");
  });
});

describe("parseFindings", () => {
  it("keeps valid findings, drops junk", () => {
    expect(parseFindings([{ id: "a", severity: "warn", text: "t" }, { id: 1 }, null, { id: "b", severity: "bogus", text: "x" }])).toEqual([{ id: "a", severity: "warn", text: "t" }]);
    expect(parseFindings("x")).toEqual([]);
  });
});
