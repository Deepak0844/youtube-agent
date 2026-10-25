import { describe, expect, it } from "vitest";
import { checkUploadPreconditions, isStalled, type UploadCaps } from "@/server/core/upload-rules";

const caps: UploadCaps = { maxPerDay: 6, minSpacingMs: 3_600_000, dailyQuotaUnits: 10_000, costUnits: 1_600 };
const now = new Date("2026-10-25T12:00:00.000Z");
const base = {
  approvalHash: "a",
  currentApprovalHash: "a",
  fileSha: "f",
  currentFileSha: "f",
  caps,
  uploadsToday: 0,
  lastUploadAt: null as Date | null,
  quotaUsedToday: 0,
  now,
};
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("checkUploadPreconditions", () => {
  it("ok when everything holds", () => expect(checkUploadPreconditions(base)).toEqual({ ok: true }));
  it("approval_changed", () =>
    expect(checkUploadPreconditions({ ...base, currentApprovalHash: "b" })).toEqual({ ok: false, reason: "approval_changed" }));
  it("file_changed", () =>
    expect(checkUploadPreconditions({ ...base, currentFileSha: "g" })).toEqual({ ok: false, reason: "file_changed" }));
  it("daily cap refuses at >= maxPerDay, allows one below", () => {
    expect(checkUploadPreconditions({ ...base, uploadsToday: 5 })).toEqual({ ok: true });
    expect(checkUploadPreconditions({ ...base, uploadsToday: 6 })).toEqual({ ok: false, reason: "daily_cap" });
    expect(checkUploadPreconditions({ ...base, uploadsToday: 7 })).toEqual({ ok: false, reason: "daily_cap" });
  });
  it("spacing refuses strictly under min, exactly equal is allowed", () => {
    expect(checkUploadPreconditions({ ...base, lastUploadAt: ago(3_599_999) })).toEqual({ ok: false, reason: "spacing" });
    expect(checkUploadPreconditions({ ...base, lastUploadAt: ago(3_600_000) })).toEqual({ ok: true });
  });
  it("quota refuses when used + cost > daily, equal allowed", () => {
    expect(checkUploadPreconditions({ ...base, quotaUsedToday: 8_400 })).toEqual({ ok: true });
    expect(checkUploadPreconditions({ ...base, quotaUsedToday: 8_401 })).toEqual({ ok: false, reason: "quota" });
  });
  it("checks in order: approval, file, daily_cap, spacing, quota", () => {
    const all = { ...base, currentApprovalHash: "x", currentFileSha: "x", uploadsToday: 6, lastUploadAt: ago(1), quotaUsedToday: 99_999 };
    expect(checkUploadPreconditions(all)).toMatchObject({ reason: "approval_changed" });
    expect(checkUploadPreconditions({ ...all, currentApprovalHash: "a" })).toMatchObject({ reason: "file_changed" });
    expect(checkUploadPreconditions({ ...all, currentApprovalHash: "a", currentFileSha: "f" })).toMatchObject({ reason: "daily_cap" });
    expect(checkUploadPreconditions({ ...all, currentApprovalHash: "a", currentFileSha: "f", uploadsToday: 0 })).toMatchObject({ reason: "spacing" });
    expect(
      checkUploadPreconditions({ ...all, currentApprovalHash: "a", currentFileSha: "f", uploadsToday: 0, lastUploadAt: null }),
    ).toMatchObject({ reason: "quota" });
  });
  it("rejects invalid numbers and dates with RangeError", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => checkUploadPreconditions({ ...base, uploadsToday: bad })).toThrow(RangeError);
      expect(() => checkUploadPreconditions({ ...base, quotaUsedToday: bad })).toThrow(RangeError);
      expect(() => checkUploadPreconditions({ ...base, caps: { ...caps, maxPerDay: bad } })).toThrow(RangeError);
      expect(() => checkUploadPreconditions({ ...base, caps: { ...caps, minSpacingMs: bad } })).toThrow(RangeError);
      expect(() => checkUploadPreconditions({ ...base, caps: { ...caps, dailyQuotaUnits: bad } })).toThrow(RangeError);
      expect(() => checkUploadPreconditions({ ...base, caps: { ...caps, costUnits: bad } })).toThrow(RangeError);
    }
    expect(() => checkUploadPreconditions({ ...base, now: new Date("nope") })).toThrow(RangeError);
    expect(() => checkUploadPreconditions({ ...base, lastUploadAt: new Date("nope") })).toThrow(RangeError);
  });
});

describe("isStalled", () => {
  it("true at exactly noProgressMs, false just under", () => {
    expect(isStalled(ago(999), now, 1000)).toBe(false);
    expect(isStalled(ago(1000), now, 1000)).toBe(true);
    expect(isStalled(ago(5000), now, 1000)).toBe(true);
  });
  it("rejects invalid input", () => {
    expect(() => isStalled(new Date("x"), now, 1000)).toThrow(RangeError);
    expect(() => isStalled(now, new Date("x"), 1000)).toThrow(RangeError);
    for (const bad of [-1, 1.5, NaN, Infinity]) expect(() => isStalled(now, now, bad)).toThrow(RangeError);
  });
});
