import { describe, expect, it } from "vitest";
import { deletesOn } from "@/server/core/asset-deletion";
import { SAFETY_KEYS, parseSetting } from "@/server/core/settings-registry";

const DAY = 86_400_000;
const base = { finishedAt: null, keep: false, pinnedToSeries: false, retentionDays: 7, createdAt: new Date("2026-01-01T00:00:00Z"), usedByAnyVideo: false, unusedDays: 30 };

describe("deletesOn", () => {
  it("keep_and_pinned_never_delete", () => {
    expect(deletesOn({ ...base, keep: true })).toBeNull();
    expect(deletesOn({ ...base, pinnedToSeries: true })).toBeNull();
    expect(deletesOn({ ...base, usedByAnyVideo: true, finishedAt: new Date(), keep: true })).toBeNull();
  });
  it("unused_upload_deletes_after_30_days", () => {
    expect(deletesOn(base)).toEqual(new Date(base.createdAt.getTime() + 30 * DAY));
  });
  it("used_unfinished_has_no_date", () => {
    expect(deletesOn({ ...base, usedByAnyVideo: true })).toBeNull();
  });
  it("finished_plus_retention", () => {
    const finishedAt = new Date("2026-02-01T00:00:00Z");
    expect(deletesOn({ ...base, usedByAnyVideo: true, finishedAt })).toEqual(new Date(finishedAt.getTime() + 7 * DAY));
  });
});

describe("asset retention settings", () => {
  it("retention_out_of_range_rejected", () => {
    for (const bad of [0, 61, -1, 1.5, "7"]) expect(() => parseSetting("assets.retention_days", bad)).toThrow();
    expect(parseSetting("assets.retention_days", 1)).toBe(1);
    expect(parseSetting("assets.retention_days", 60)).toBe(60);
  });
  it("are session-only (safety list)", () => {
    for (const k of ["assets.retention_days", "assets.unused_days", "assets.trash_days"]) expect(SAFETY_KEYS).toContain(k);
  });
});
