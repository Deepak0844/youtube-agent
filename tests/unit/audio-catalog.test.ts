import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHIPPED_LICENCE, mapCatalog, unlistedFiles } from "@/server/core/audio-catalog";

const cat = { clips: [{ id: "whoosh", file: "clips/whoosh.mp3", category: "motion", tags: ["air"], source: "elevenlabs:x", model: "m", prompt: "p", license: "old" }] };

describe("audio catalog mapping", () => {
  it("maps_old_fields_and_stamps_licence", () => {
    const [e] = mapCatalog("sfx", cat);
    expect(e).toMatchObject({ kind: "sfx", name: "whoosh", file: "clips/whoosh.mp3", tags: ["air", "motion"], source: "shipped", licence: SHIPPED_LICENCE });
    expect(e!.provenance).toMatchObject({ catalogId: "whoosh", originalSource: "elevenlabs:x", model: "m" });
  });
  it("rejects_bad_catalog_and_path_escape", () => {
    expect(() => mapCatalog("sfx", { clips: [{ id: "x" }] })).toThrow();
    expect(() => mapCatalog("sfx", { clips: [{ ...cat.clips[0], file: "../x.mp3" }] })).toThrow();
  });
  it("lists_files_without_catalog_entry", () => {
    expect(unlistedFiles(["clips/whoosh.mp3", "clips/rogue.mp3"], mapCatalog("sfx", cat))).toEqual(["clips/rogue.mp3"]);
  });
  it("shipped_catalogs_map_and_match_files_on_disk", () => {
    for (const [kind, n] of [["sfx", 23], ["music", 0]] as const) {
      const dir = `assets-builtin/audio/${kind}`;
      const entries = mapCatalog(kind, JSON.parse(readFileSync(`${dir}/catalog.json`, "utf8")));
      expect(entries).toHaveLength(n);
      expect(entries.every((e) => existsSync(`${dir}/${e.file}`))).toBe(true);
      expect(unlistedFiles((existsSync(`${dir}/clips`) ? readdirSync(`${dir}/clips`) : []).map((f) => `clips/${f}`), entries)).toEqual([]);
    }
  });
  it("a clip's own licence is kept, a blank one is refused, the default stays for the rest", () => {
    const own = { ...cat.clips[0], licence: "CC0 1.0, Kenney", source_url: "https://kenney.nl/assets/ui-audio" };
    expect(mapCatalog("sfx", { clips: [own] })[0]).toMatchObject({ licence: "CC0 1.0, Kenney", provenance: { sourceUrl: "https://kenney.nl/assets/ui-audio" } });
    expect(() => mapCatalog("sfx", { clips: [{ ...own, licence: "  " }] })).toThrow();
    expect(mapCatalog("sfx", cat)[0]!.licence).toBe(SHIPPED_LICENCE);
  });
  it("every added clip names its licence and covers its recipe's tags (a cue finds clips by tag)", () => {
    const dir = "assets-builtin/audio/sfx";
    const raw = JSON.parse(readFileSync(`${dir}/catalog.json`, "utf8")) as { clips: { id: string; recipe?: string; licence?: string }[] };
    const palette = (JSON.parse(readFileSync(`${dir}/palette.json`, "utf8")) as { sounds: { id: string; tags: string[] }[] }).sounds;
    const entries = mapCatalog("sfx", raw);
    for (const c of raw.clips.filter((x) => x.recipe)) {
      const e = entries.find((x) => x.name === c.id)!;
      expect(e.licence, c.id).not.toBe(SHIPPED_LICENCE);
      expect(e.licence, c.id).toMatch(/CC0|ffmpeg/);
      const recipe = palette.find((r) => r.id === c.recipe);
      expect(recipe, c.id).toBeDefined();
      expect(e.tags, c.id).toEqual(expect.arrayContaining(recipe!.tags));
    }
  });
});
