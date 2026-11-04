import { describe, expect, it } from "vitest";
import { systemFormSchema } from "@/server/db/system-settings";

const base = { concurrent_renders: 1, concurrent_jobs: 2, storage_warn_gb: 50, max_long_minutes: 15, scene_kit: true };

describe("systemFormSchema render_timeout_s", () => {
  it.each([900, "900", 60, 3600])("accepts %s", (v) => {
    expect(systemFormSchema.safeParse({ ...base, render_timeout_s: v }).success).toBe(true);
  });
  it.each([59, 3601, "1e3", "", 0, 1.5])("rejects %s", (v) => {
    expect(systemFormSchema.safeParse({ ...base, render_timeout_s: v }).success).toBe(false);
  });
});
