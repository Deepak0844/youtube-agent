import { describe, expect, it } from "vitest";
import { createAdmission } from "@/server/core/admission";

describe("admission", () => {
  it("global_cap", () => {
    const a = createAdmission({ maxTotal: 3, maxPerKey: 3 });
    const r = ["a", "b", "c"].map((k) => a.tryEnter(k));
    expect(r.every(Boolean)).toBe(true);
    expect(a.tryEnter("d")).toBeNull();
    r[0]!();
    expect(a.tryEnter("d")).not.toBeNull();
  });
  it("per_key_cap", () => {
    const a = createAdmission({ maxTotal: 10, maxPerKey: 1 });
    const r = a.tryEnter("ip");
    expect(a.tryEnter("ip")).toBeNull();
    expect(a.tryEnter("other")).not.toBeNull();
    r!();
    expect(a.tryEnter("ip")).not.toBeNull();
  });
  it("release_is_idempotent_and_never_negative", () => {
    const a = createAdmission({ maxTotal: 2, maxPerKey: 2 });
    const r = a.tryEnter("k")!;
    r();
    r();
    r();
    expect(a.inFlight()).toBe(0);
    expect(a.tryEnter("k")).not.toBeNull();
    expect(a.tryEnter("k")).not.toBeNull();
    expect(a.tryEnter("k")).toBeNull(); // still capped at 2: a double release did not mint extra slots
  });
  it("rejects_bad_config", () => {
    expect(() => createAdmission({ maxTotal: 0, maxPerKey: 1 })).toThrow();
    expect(() => createAdmission({ maxTotal: 1, maxPerKey: 0 })).toThrow();
  });
});
