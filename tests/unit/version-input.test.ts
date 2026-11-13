import { describe, expect, it } from "vitest";
import { CAPTION_STYLE_IDS } from "../../remotion/kit/presets";
import { VERSION_KINDS, versionInput, type VersionSource } from "@/server/core/videos-view";

const CAPTION = CAPTION_STYLE_IDS[0]!;

const src = (o: Partial<VersionSource> = {}): VersionSource => ({ topic: "Why the sea is salty", language: "ta", notes: "calm tone", style: "ai_studio", captionStyle: CAPTION, format: "short", kind: "scene_kit", ...o });

describe("versionInput (remake a Short as another type)", () => {
  it("keeps the topic, notes and language, and the style and caption look only where the new type uses them", () => {
    expect(versionInput(src({ kind: "tsx" }), "scene_kit")).toEqual({ ok: true, value: { topic: "Why the sea is salty", language: "ta", kind: "scene_kit", format: "short", notes: "calm tone", style: "ai_studio", captionStyle: CAPTION } });
    expect(versionInput(src(), "tsx")).toEqual({ ok: true, value: { topic: "Why the sea is salty", language: "ta", kind: "tsx", format: "short", notes: "calm tone", style: "ai_studio" } }); // a custom animation burns its own captions
  });
  it("leaves out a style or caption look that is not set or not a known one, and notes that are empty", () => {
    const v = versionInput(src({ kind: "tsx", style: null, captionStyle: "nonsense", notes: null }), "scene_kit");
    expect(v).toEqual({ ok: true, value: { topic: "Why the sea is salty", language: "ta", kind: "scene_kit", format: "short", notes: undefined } });
  });
  it("refuses a long video, the same type, an unknown or non-text type, and an unknown language, in plain words", () => {
    expect(versionInput(src({ format: "long" }), "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/Only a Short/) });
    expect(versionInput(src(), "scene_kit")).toMatchObject({ ok: false, message: expect.stringMatching(/already is/) });
    for (const bad of ["", "collage", "long", "ai", undefined, null, 5, { kind: "tsx" }, ["tsx"]]) expect(versionInput(src(), bad), String(bad)).toMatchObject({ ok: false, message: "Pick a video type from the list." });
    expect(versionInput(src({ language: "xx" }), "tsx")).toMatchObject({ ok: false, message: expect.stringMatching(/unknown language/) });
  });
  it("offers exactly the types the New form offers for a Short", () => {
    expect([...VERSION_KINDS]).toEqual(["scene_kit", "tsx"]);
  });
});
