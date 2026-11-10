import { describe, expect, it } from "vitest";
import { FLAGS, isEnabled } from "@/lib/flags";

describe("feature flags", () => {
  it("only the pages built so far (Phase 1, /queue from Phase 2, budgets, providers, assets and asset settings from Phase 3) are on", () => {
    const on = Object.entries(FLAGS).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on).toEqual(["assets", "home", "ideas", "library", "new", "plan.calendar", "plan.research", "plan.targets", "publish.analytics", "publish.engagement", "queue", "series", "settings.account", "settings.assets", "settings.audit", "settings.budgets", "settings.channels", "settings.google", "settings.keys", "settings.models", "settings.notifications", "settings.policies", "settings.providers", "settings.schedule", "settings.system", "settings.tokens"]);
  });
  it("Phase 6b.1 Series is on; the rest of Phase 6b stays off", () => {
    expect(isEnabled("series")).toBe(true);
  });
  it("an unknown flag is off", () => expect(isEnabled("nope")).toBe(false));
});
