import { describe, expect, it } from "vitest";
import { systemFormSchema } from "@/server/db/system-settings";

const base = { concurrent_renders: 1, concurrent_jobs: 2, storage_warn_gb: 50, max_long_minutes: 15, native_3d: false, native_timeout_s: 1800, scene_kit: true };

describe("systemFormSchema render_timeout_s", () => {
  it.each([900, "900", 60, 3600])("accepts %s", (v) => {
    expect(systemFormSchema.safeParse({ ...base, render_timeout_s: v }).success).toBe(true);
  });
  it.each([59, 3601, "1e3", "", 0, 1.5])("rejects %s", (v) => {
    expect(systemFormSchema.safeParse({ ...base, render_timeout_s: v }).success).toBe(false);
  });
});

describe("systemFormSchema native 3D fields", () => {
  const ok = (o: object) => systemFormSchema.safeParse({ ...base, render_timeout_s: 900, ...o }).success;
  it.each([60, 1800, "1800", 7200])("accepts native_timeout_s %s", (v) => expect(ok({ native_timeout_s: v })).toBe(true));
  it.each([59, 7201, "1e3", "", 0, 1.5])("rejects native_timeout_s %s", (v) => expect(ok({ native_timeout_s: v })).toBe(false));
  it.each(["on", 1, null])("rejects native_3d %s (a real boolean only)", (v) => expect(ok({ native_3d: v })).toBe(false));
  it("both fields are required", () => {
    const rest: Record<string, unknown> = { ...base };
    delete rest.native_3d;
    expect(systemFormSchema.safeParse({ ...rest, render_timeout_s: 900 }).success).toBe(false);
  });
});
