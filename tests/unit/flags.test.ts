import { describe, expect, it } from "vitest";
import { FLAGS, isEnabled } from "@/lib/flags";

describe("feature flags", () => {
  it("only the pages built so far (Phase 1, /queue from Phase 2, budgets, providers, assets and asset settings from Phase 3) are on", () => {
    const on = Object.entries(FLAGS).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on).toEqual(["assets", "home", "ideas", "library", "new", "plan.research", "plan.targets", "publish.analytics", "publish.engagement", "queue", "settings.assets", "settings.audit", "settings.budgets", "settings.channels", "settings.google", "settings.keys", "settings.models", "settings.notifications", "settings.providers", "settings.schedule", "settings.system", "settings.tokens"]);
  });
  it("Phase 6 / 6b pages stay off", () => {
    for (const f of ["series", "plan.calendar"]) expect(isEnabled(f), f).toBe(false);
  });
  it("an unknown flag is off", () => expect(isEnabled("nope")).toBe(false));
});
