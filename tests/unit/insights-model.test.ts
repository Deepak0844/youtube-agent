import { describe, expect, it } from "vitest";
import { insightsStageId } from "@/server/db/insights-model";

describe("insightsStageId", () => {
  it("is_stable_for_the_same_job_and_period", () => {
    expect(insightsStageId("review", "2026-W45")).toBe(insightsStageId("review", "2026-W45"));
  });
  it("differs_by_job_and_by_period", () => {
    const ids = new Set([insightsStageId("review", "2026-W45"), insightsStageId("optimizer", "2026-W45"), insightsStageId("review", "2026-W46")]);
    expect(ids.size).toBe(3);
  });
  it("is_a_valid_uuid", () => {
    expect(insightsStageId("review", "2026-W45")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
