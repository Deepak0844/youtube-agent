import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePalette } from "@/server/core/sfx-palette";

const load = (k: "sfx" | "music") => JSON.parse(readFileSync(`assets-builtin/audio/${k}/palette.json`, "utf8"));

describe("sfx palette", () => {
  it("loads_the_shipped_sfx_and_music_palettes", () => {
    const s = parsePalette("sfx", load("sfx"));
    expect(s.recipes.length).toBeGreaterThan(20);
    expect(s).toMatchObject({ model: "eleven_text_to_sound_v2", targetLufs: -20, ceilingDbfs: -1.5 });
    expect(s.recipes[0]).toMatchObject({ id: "whoosh-soft", durationS: 0.7 });
    expect(parsePalette("music", load("music")).recipes[0]!.id).toBe("ambient-pad");
  });
  it("refuses_repeated_ids_and_tagless_recipes", () => {
    const j = load("sfx");
    expect(() => parsePalette("sfx", { ...j, sounds: [j.sounds[0], j.sounds[0]] })).toThrow(/repeated/);
    expect(() => parsePalette("sfx", { ...j, sounds: [{ ...j.sounds[0], tags: [] }] })).toThrow();
  });
});
