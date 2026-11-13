import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OLD_LIBS } from "@/server/core/oldlib-names";
import { buildOldlibDts, INDEX_FILE, indexDoc, NAMES_FILE, namesModule, TYPES_DIR } from "../../scripts/sync-oldlib-dts";

// The old libraries' declarations and the allowed yt-old names are GENERATED (scripts/sync-oldlib-dts.ts); this fails when a
// library changed without re-running the generator, so the allow-list can never drift from what the files export.

describe("yt-old declarations and names", () => {
  const dts = buildOldlibDts();

  it("generated_names_match_the_libraries", () => {
    expect(readFileSync(NAMES_FILE, "utf8")).toBe(namesModule(dts));
    expect(readFileSync(INDEX_FILE, "utf8")).toBe(indexDoc(dts));
    for (const [rel, text] of dts) expect(readFileSync(path.join(TYPES_DIR, rel), "utf8"), rel).toBe(text);
  });

  it("type_only_exports_are_not_listed", () => {
    // geo/world.ts exports the types Ring and Country and the value WORLD; geo stays internal, and no listed name is a type.
    expect(Object.keys(OLD_LIBS)).not.toContain("yt-old/geo/world");
    for (const [mod, names] of Object.entries(OLD_LIBS)) {
      const text = dts.get(`${mod.slice("yt-old/".length)}.d.ts`) ?? "";
      for (const n of names) expect(text, `${mod} ${n}`).toMatch(new RegExp(`export (declare )?(const|function) ${n}\\b`));
    }
  });

  it("covers every library and nothing else", () => {
    expect(Object.keys(OLD_LIBS).length).toBe(24);
    for (const m of Object.keys(OLD_LIBS)) expect(m).toMatch(/^yt-old\/[a-z][a-z0-9]*$/);
  });
});
