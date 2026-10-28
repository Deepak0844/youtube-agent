import { describe, expect, it } from "vitest";
import { dryRunAllowed } from "@/lib/dry-run";
import { cutStages } from "@/ui/domain/queue-strip";
import { visibleNav } from "@/ui/shell/nav-config";

const states = (s: ReturnType<typeof cutStages>) => s.map((x) => `${x.key}:${x.state}`).join(" ");

describe("cutStages", () => {
  it("holds the draft segment at the script gate and leaves the rest waiting", () => {
    const s = cutStages({ runs: { draft: "succeeded" }, openGate: "script", upload: null });
    expect(states(s)).toBe("draft:held build:todo voice:todo render:todo sound:todo check:todo review:todo publish:todo");
    expect(s[0]!.gate).toBe("script");
  });
  it("holds build at the cost gate with the draft done", () => {
    expect(states(cutStages({ runs: { draft: "succeeded", build: "succeeded" }, openGate: "cost", upload: null }))).toBe("draft:done build:held voice:todo render:todo sound:todo check:todo review:todo publish:todo");
  });
  it("the video and evidence gates hold Review with every earlier segment done; publish holds Publish", () => {
    const early = "draft:done build:done voice:done render:done sound:done check:done";
    expect(states(cutStages({ runs: { qa: "succeeded" }, openGate: "video", upload: null }))).toBe(`${early} review:held publish:todo`);
    expect(states(cutStages({ runs: { qa: "succeeded" }, openGate: "evidence", upload: null }))).toBe(`${early} review:held publish:todo`);
    expect(states(cutStages({ runs: { qa: "succeeded" }, openGate: "publish", upload: null }))).toBe(`${early} review:done publish:held`);
  });
  it("shows a running stage, a failed stage and a parked stage", () => {
    expect(states(cutStages({ runs: { draft: "succeeded", build: "running" }, openGate: null, upload: null }))).toContain("build:running");
    expect(states(cutStages({ runs: { draft: "succeeded", build: "failed" }, openGate: null, upload: null }))).toContain("build:failed");
    expect(states(cutStages({ runs: { draft: "succeeded", build: "needs_decision" }, openGate: null, upload: null }))).toContain("build:held");
  });
  it("tracks the upload on the Publish segment", () => {
    const last = (u: Parameters<typeof cutStages>[0]["upload"]) => cutStages({ runs: { qa: "succeeded" }, openGate: null, upload: u })[7]!.state;
    expect(last("publish_approved")).toBe("running");
    expect(last("uploaded")).toBe("done");
    expect(last("upload_failed")).toBe("failed");
  });
});

describe("dry run availability and navigation", () => {
  it("needs ENGINE_DRY_RUN=1 and a non-production build", () => {
    expect(dryRunAllowed({ NODE_ENV: "development", ENGINE_DRY_RUN: "1" })).toBe(true);
    expect(dryRunAllowed({ NODE_ENV: "development" })).toBe(false); // development alone is not an opt-in
    expect(dryRunAllowed({ NODE_ENV: "development", ENGINE_DRY_RUN: "0" })).toBe(false);
    expect(dryRunAllowed({ NODE_ENV: "production", ENGINE_DRY_RUN: "1" })).toBe(false);
  });
  it("the nav lists /queue", () => {
    const hrefs = visibleNav().flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain("/queue");
  });
});
