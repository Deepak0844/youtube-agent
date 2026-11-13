import { describe, expect, it } from "vitest";
import { ageLabel, libraryHref, parseLibraryQuery, parseNewVideoForm } from "@/server/core/videos-view";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseLibraryQuery", () => {
  it("reads known filters and the page", () => {
    expect(parseLibraryQuery({ format: "short", status: "waiting", language: "ta", kind: "collage", page: "3" })).toEqual({ format: "short", status: "waiting", language: "ta", kind: "collage", page: 3 });
  });
  it("ignores unknown values, arrays take the first, bad pages become 1", () => {
    expect(parseLibraryQuery({ status: "nope", language: ["hi", "en"], page: "-2" })).toEqual({ format: undefined, status: undefined, language: "hi", kind: undefined, page: 1 });
    expect(parseLibraryQuery({ page: "1.5" }).page).toBe(1);
    expect(parseLibraryQuery({ page: "abc" }).page).toBe(1);
  });
});

describe("libraryHref", () => {
  it("keeps filters, drops page 1 and empties", () => {
    const f = parseLibraryQuery({ status: "done", page: "2" });
    expect(libraryHref(f)).toBe("/videos?status=done&page=2");
    expect(libraryHref(f, { page: 1 })).toBe("/videos?status=done");
    expect(libraryHref(f, { status: undefined, page: undefined })).toBe("/videos");
  });
});

describe("ageLabel", () => {
  const now = new Date("2026-01-02T12:00:00Z");
  it("is coarse", () => {
    expect(ageLabel(new Date("2026-01-02T11:59:50Z"), now)).toBe("just now");
    expect(ageLabel(new Date("2026-01-02T11:30:00Z"), now)).toBe("30 min ago");
    expect(ageLabel(new Date("2026-01-02T07:00:00Z"), now)).toBe("5 h ago");
    expect(ageLabel(new Date("2025-12-30T12:00:00Z"), now)).toBe("3 d ago");
  });
});

describe("parseNewVideoForm: collage", () => {
  it("is a Short with the usual look and captions, and never carries a character", () => {
    const r = parseNewVideoForm(form({ topic: "x", language: "en", kind: "collage", style: "flat_motion", captionStyle: "punchy_captions", character: "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91" }));
    expect(r).toMatchObject({ ok: true, value: { kind: "collage", format: "short", style: "flat_motion", captionStyle: "punchy_captions" } });
    expect(r.ok && "characterAssetId" in r.value).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "collage", format: "long" }))).toMatchObject({ ok: false });
  });
});

describe("parseNewVideoForm: AI videos", () => {
  const id = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
  it("is a Short with an optional locked character and the usual look", () => {
    expect(parseNewVideoForm(form({ topic: "A fox", language: "en", kind: "ai" }))).toEqual({ ok: true, value: { topic: "A fox", language: "en", kind: "ai", format: "short", notes: undefined } });
    const r = parseNewVideoForm(form({ topic: "A fox", language: "en", kind: "ai", character: id, style: "flat_motion", captionStyle: "punchy_captions" }));
    expect(r).toMatchObject({ ok: true, value: { kind: "ai", characterAssetId: id, style: "flat_motion", captionStyle: "punchy_captions" } });
  });
  it("refuses a character that is not an id, and a long AI video; other kinds never carry a character", () => {
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "ai", character: "../../etc" }))).toMatchObject({ ok: false });
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "ai", format: "long", minMinutes: "3", maxMinutes: "8" }))).toMatchObject({ ok: false, message: expect.stringMatching(/Scene kit/) });
    const sk = parseNewVideoForm(form({ topic: "x", language: "en", kind: "collage", character: id }));
    expect(sk.ok && "characterAssetId" in sk.value).toBe(false);
  });
});

describe("parseNewVideoForm", () => {
  it("accepts a topic and each of the six languages, trimming the topic", () => {
    for (const language of ["en", "hi", "ta", "te", "kn", "ml"]) {
      const r = parseNewVideoForm(form({ topic: "  Why the sky is blue ", language }));
      expect(r).toEqual({ ok: true, value: { topic: "Why the sky is blue", language, kind: "tsx", format: "short", notes: undefined } }); // Custom animation is the default type
    }
  });
  it("custom animation (tsx) is accepted; the caption style is dropped, the style is kept", () => {
    const tsx = parseNewVideoForm(form({ topic: "x", language: "en", kind: "tsx", style: "flat_motion", captionStyle: "punchy_captions" }));
    expect(tsx).toEqual({ ok: true, value: { topic: "x", language: "en", kind: "tsx", format: "short", notes: undefined, style: "flat_motion" } });
    const plain = parseNewVideoForm(form({ topic: "x", language: "en", kind: "tsx" }));
    expect(plain).toEqual({ ok: true, value: { topic: "x", language: "en", kind: "tsx", format: "short", notes: undefined } });
    const kit = parseNewVideoForm(form({ topic: "x", language: "en", style: "flat_motion" }));
    expect(kit.ok && kit.value.style).toBe("flat_motion");
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "tsx", format: "long" })).ok).toBe(false);
  });
  it("refuses empty or too long topics and unknown language/kind/format", () => {
    expect(parseNewVideoForm(form({ topic: "   ", language: "en" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x".repeat(201), language: "en" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x".repeat(200), language: "en" })).ok).toBe(true);
    expect(parseNewVideoForm(form({ topic: "x", language: "fr" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "hologram" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x", language: "en", format: "wide" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ language: "en" })).ok).toBe(false);
  });
  it("long videos are refused for every type (they were made with the scene kit)", () => {
    for (const kind of ["tsx", "collage", "ai"]) expect(parseNewVideoForm(form({ topic: "x", language: "en", kind, format: "long" }))).toMatchObject({ ok: false, message: expect.stringContaining("Scene kit") });
  });
  it("a Short never carries a length range", () => {
    const r = parseNewVideoForm(form({ topic: "x", language: "en", minMinutes: "5", maxMinutes: "9" }));
    expect(r.ok && Object.keys(r.value).sort()).toEqual(["format", "kind", "language", "notes", "topic"]);
    expect(r.ok && r.value.lengthMin).toBeUndefined();
  });
  it("keeps notes up to 2000 characters", () => {
    expect(parseNewVideoForm(form({ topic: "x", language: "en", notes: "n".repeat(2001) })).ok).toBe(false);
    const r = parseNewVideoForm(form({ topic: "x", language: "en", notes: " keep it short " }));
    expect(r.ok && r.value.notes).toBe("keep it short");
  });
});
