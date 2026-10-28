import { describe, expect, it } from "vitest";
import { FLAGS, isEnabled } from "@/lib/flags";

describe("feature flags", () => {
  it("only the pages built so far (Phase 1, plus /queue from Phase 2) are on", () => {
    const on = Object.entries(FLAGS).filter(([, v]) => v).map(([k]) => k).sort();
    expect(on).toEqual(["home", "queue", "settings.audit", "settings.google", "settings.keys", "settings.models", "settings.system"]);
  });
  it("Phase 6 / 6b pages stay off", () => {
    for (const f of ["ideas", "series", "plan.calendar", "plan.research", "plan.targets", "settings.schedule"]) expect(isEnabled(f), f).toBe(false);
  });
  it("an unknown flag is off", () => expect(isEnabled("nope")).toBe(false));
});
