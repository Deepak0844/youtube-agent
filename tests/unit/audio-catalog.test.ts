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
    for (const [kind, n] of [["sfx", 33], ["music", 6]] as const) {
      const dir = `assets-builtin/audio/${kind}`;
      const entries = mapCatalog(kind, JSON.parse(readFileSync(`${dir}/catalog.json`, "utf8")));
      expect(entries).toHaveLength(n);
      expect(entries.every((e) => existsSync(`${dir}/${e.file}`))).toBe(true);
      expect(unlistedFiles(readdirSync(`${dir}/clips`).map((f) => `clips/${f}`), entries)).toEqual([]);
    }
  });
});
