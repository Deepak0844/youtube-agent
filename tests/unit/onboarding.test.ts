import { describe, expect, it } from "vitest";
import { dryRunChecks, onboardingSteps, setupIncomplete, type OnboardingFacts } from "@/server/core/onboarding";

const none: OnboardingFacts = { llmKeySaved: false, modelChosen: false, googleAppSaved: false, channelConnected: false, vaultReadable: true };
const all: OnboardingFacts = { ...none, llmKeySaved: true, modelChosen: true, googleAppSaved: true, channelConnected: true };
const done = (f: OnboardingFacts) => onboardingSteps(f).map((s) => s.done);

describe("onboarding steps", () => {
  it("nothing saved: every step open, setup incomplete", () => {
    expect(done(none)).toEqual([false, false, false, false, false]);
    expect(setupIncomplete(none)).toBe(true);
  });
  it("each step follows its own fact", () => {
    expect(done({ ...none, llmKeySaved: true })).toEqual([true, false, false, false, false]);
    expect(done({ ...none, modelChosen: true })).toEqual([false, true, false, false, false]);
    expect(done({ ...none, googleAppSaved: true })).toEqual([false, false, true, false, false]);
    expect(done({ ...none, channelConnected: true })).toEqual([false, false, false, true, false]);
  });
  it("readiness needs all four plus a readable vault", () => {
    expect(done(all)).toEqual([true, true, true, true, true]);
    expect(setupIncomplete(all)).toBe(false);
    expect(done({ ...all, vaultReadable: false })[4]).toBe(false);
    expect(dryRunChecks({ ...all, vaultReadable: false }).filter((c) => !c.ok)).toHaveLength(1);
  });
  it("steps link to the existing settings pages", () => {
    expect(onboardingSteps(none).map((s) => s.href)).toEqual(["/settings/keys", "/settings/models", "/settings/google", "/settings/channels", "/onboarding#dryrun"]);
  });
});
