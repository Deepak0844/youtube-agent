import { describe, expect, it } from "vitest";
import { VERSION_KINDS, versionInput, type VersionSource } from "@/server/core/videos-view";

const src = (o: Partial<VersionSource> = {}): VersionSource => ({ topic: "Why the sea is salty", language: "ta", notes: "calm tone", style: "ai_studio", captionStyle: "punchy_captions", format: "short", kind: "collage", ...o });

describe("versionInput (remake a Short as another type)", () => {
  it("keeps the topic, notes, language and style; a custom animation burns its own captions", () => {
    expect(versionInput(src(), "tsx")).toEqual({ ok: true, value: { topic: "Why the sea is salty", language: "ta", kind: "tsx", format: "short", notes: "calm tone", style: "ai_studio" } });
  });
  it("leaves out a style that is not a known one, and notes that are empty", () => {
    expect(versionInput(src({ style: "nonsense", notes: null }), "tsx")).toEqual({ ok: true, value: { topic: "Why the sea is salty", language: "ta", kind: "tsx", format: "short", notes: undefined } });
  });
  it("refuses a long video, the same type, an unknown type, and an unknown language, in plain words", () => {
    expect(versionInput(src({ format: "long" }), "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/Only a Short/) });
    expect(versionInput(src({ kind: "tsx" }), "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/already is/) });
    for (const bad of ["", "scene_kit", "collage", "long", "ai", undefined, null, 5, { kind: "tsx" }, ["tsx"]]) expect(versionInput(src(), bad), String(bad)).toMatchObject({ ok: false, message: "Pick a video type from the list." });
    expect(versionInput(src({ language: "xx" }), "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/unknown language/) });
  });
  it("offers only Custom animation", () => {
    expect([...VERSION_KINDS]).toEqual(["tsx"]);
  });
});
