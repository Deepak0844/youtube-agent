import { describe, expect, it } from "vitest";
import { ageLabel, libraryHref, parseLibraryQuery, parseNewVideoForm } from "@/server/core/videos-view";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseLibraryQuery", () => {
  it("reads known filters and the page", () => {
    expect(parseLibraryQuery({ format: "short", status: "waiting", language: "ta", kind: "scene_kit", page: "3" })).toEqual({ format: "short", status: "waiting", language: "ta", kind: "scene_kit", page: 3 });
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

describe("parseNewVideoForm", () => {
  it("accepts a topic and each of the six languages, trimming the topic", () => {
    for (const language of ["en", "hi", "ta", "te", "kn", "ml"]) {
      const r = parseNewVideoForm(form({ topic: "  Why the sky is blue ", language }));
      expect(r).toEqual({ ok: true, value: { topic: "Why the sky is blue", language, kind: "scene_kit", format: "short", notes: undefined } });
    }
  });
  it("refuses empty or too long topics and unknown language/kind/format", () => {
    expect(parseNewVideoForm(form({ topic: "   ", language: "en" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x".repeat(201), language: "en" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x".repeat(200), language: "en" })).ok).toBe(true);
    expect(parseNewVideoForm(form({ topic: "x", language: "fr" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x", language: "en", kind: "ai" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ topic: "x", language: "en", format: "long" })).ok).toBe(false);
    expect(parseNewVideoForm(form({ language: "en" })).ok).toBe(false);
  });
  it("keeps notes up to 2000 characters", () => {
    expect(parseNewVideoForm(form({ topic: "x", language: "en", notes: "n".repeat(2001) })).ok).toBe(false);
    const r = parseNewVideoForm(form({ topic: "x", language: "en", notes: " keep it short " }));
    expect(r.ok && r.value.notes).toBe("keep it short");
  });
});
