import { describe, expect, it } from "vitest";
import { publicRequirements, publicSummary } from "@/server/core/policies-view";

describe("publicSummary", () => {
  it("says nothing can go public in the default state", () => {
    expect(publicSummary({ allowPublic: false, killSwitch: false, cutoverDone: false })).toMatch(/private or unlisted only/);
  });
  it("the kill switch wins over everything else", () => {
    expect(publicSummary({ allowPublic: true, killSwitch: true, cutoverDone: true })).toMatch(/Every upload is stopped/);
  });
  it("allowed but not yet live says production channels stay locked; allowed and live says each publish still needs approval", () => {
    expect(publicSummary({ allowPublic: true, killSwitch: false, cutoverDone: false })).toMatch(/production channels stay locked/);
    expect(publicSummary({ allowPublic: true, killSwitch: false, cutoverDone: true })).toMatch(/still needs your approval/);
  });
});

describe("publicRequirements", () => {
  it("lists the four conditions; the channel one is per channel (no single yes or no)", () => {
    const r = publicRequirements({ allowPublic: false, killSwitch: true, cutoverDone: false });
    expect(r).toHaveLength(4);
    expect(r.map((x) => x.ok)).toEqual([false, null, false, false]);
    expect(r.every((x) => x.href.startsWith("/settings/"))).toBe(true);
  });
  it("all met except the per-channel one", () => {
    expect(publicRequirements({ allowPublic: true, killSwitch: false, cutoverDone: true }).map((x) => x.ok)).toEqual([true, null, true, true]);
  });
});
