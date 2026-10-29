import { describe, expect, it } from "vitest";
import { ASSET_LIMIT_DEFAULTS, checkLimits, checkRights, cleanOriginalName, mergeDuplicate, rightsSchema, RIGHTS_TEXT } from "@/server/core/asset-rules";

const att = (extra: object = {}) => ({ at: "2026-10-29T10:00:00Z", text: RIGHTS_TEXT, ...extra });

describe("rights", () => {
  it("no attestation is refused", () => {
    expect(checkRights({ attestations: [] }, { kind: "image", tags: [] })).toEqual({ ok: false, reason: "no_attestation" });
  });
  it("the attestation text must be the exact sentence", () => {
    expect(rightsSchema.safeParse({ attestations: [{ at: "2026-10-29T10:00:00Z", text: "sure" }] }).success).toBe(false);
    expect(rightsSchema.safeParse({ attestations: [att()] }).success).toBe(true);
  });
  it("a voice-clone reference needs voice consent; a photo of a person needs likeness consent", () => {
    const r = { attestations: [att()] };
    expect(checkRights(r, { kind: "audio", tags: [], voiceCloneReference: true })).toEqual({ ok: false, reason: "voice_consent_missing" });
    expect(checkRights({ attestations: [att({ consent_voice: true })] }, { kind: "audio", tags: [], voiceCloneReference: true })).toEqual({ ok: true });
    expect(checkRights(r, { kind: "image", tags: ["Person"] })).toEqual({ ok: false, reason: "likeness_consent_missing" });
    expect(checkRights({ attestations: [att({ consent_likeness: true })] }, { kind: "image", tags: ["person"] })).toEqual({ ok: true });
    expect(checkRights(r, { kind: "image", tags: ["landscape"] })).toEqual({ ok: true });
  });
});

describe("mergeDuplicate", () => {
  it("keep wins, tags union, every attestation kept in order", () => {
    const m = mergeDuplicate(
      { keep: false, tags: ["a", "b"], rights: { attestations: [att({ at: "2026-01-01T00:00:00Z" })] } },
      { keep: true, tags: ["b", "c"], rights: { attestations: [att({ at: "2026-02-01T00:00:00Z" })] } },
    );
    expect(m.keep).toBe(true);
    expect(m.tags).toEqual(["a", "b", "c"]);
    expect(m.rights.attestations.map((a) => a.at)).toEqual(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
  });
});

describe("cleanOriginalName", () => {
  it("never keeps folders, dot-dot, control characters or NUL", () => {
    expect(cleanOriginalName("../../etc/passwd\u0000.png")).toBe("passwd.png");
    expect(cleanOriginalName("C:\\Users\\me\\cat..png")).toBe("cat.png");
    expect(cleanOriginalName("..")).toBe("untitled");
    expect(cleanOriginalName("a\nb\u0007.jpg")).toBe("ab.jpg");
    expect(cleanOriginalName("x".repeat(500)).length).toBe(200);
  });
});

describe("checkLimits", () => {
  const l = ASSET_LIMIT_DEFAULTS;
  it("enforces size, batch count and total storage", () => {
    expect(checkLimits({ bytes: 1000, batchFiles: 1, storedBytes: 0 }, l)).toEqual({ ok: true });
    expect(checkLimits({ bytes: l.maxImageBytes + 1, batchFiles: 1, storedBytes: 0 }, l)).toEqual({ ok: false, reason: "too_big" });
    expect(checkLimits({ bytes: 0, batchFiles: 1, storedBytes: 0 }, l)).toEqual({ ok: false, reason: "too_big" });
    expect(checkLimits({ bytes: 10, batchFiles: 101, storedBytes: 0 }, l)).toEqual({ ok: false, reason: "too_many_files" });
    expect(checkLimits({ bytes: 10, batchFiles: 1, storedBytes: l.totalBytesCap - 5 }, l)).toEqual({ ok: false, reason: "storage_full" });
  });
  it("defaults are the Doc 13 values", () => {
    expect(l).toMatchObject({ maxImageBytes: 26_214_400, maxPixels: 50_000_000, maxBatchFiles: 100, totalBytesCap: 5_368_709_120 });
  });
});
