import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "@/shared/assets3d/catalog";
import { renderLicenses } from "@/shared/assets3d/licenses";

const dir = path.join(process.cwd(), "assets3d");
const raw: unknown = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
const rawEntries = (raw as { entries: Record<string, unknown>[] }).entries;

describe("assets3d manifest", () => {
  const catalog = loadCatalog(raw); // schema check + duplicate ids

  it("has at least 150 models plus hdris and textures", () => {
    const n = (k: string) => catalog.entries.filter((e) => e.kind === k).length;
    expect(n("model")).toBeGreaterThanOrEqual(150);
    expect(n("hdri")).toBeGreaterThanOrEqual(10);
    expect(n("texture")).toBeGreaterThanOrEqual(25);
  });

  it("every licence is CC0-1.0 or Public Domain, with evidence", () => {
    for (const e of rawEntries) {
      expect(["CC0-1.0", "Public Domain"], String(e.id)).toContain(e.license);
      expect(String(e.license_evidence).trim().length, String(e.id)).toBeGreaterThan(10);
      expect(String(e.license_evidence), String(e.id)).toMatch(/CC0|Public Domain|polyhaven\.com\/license/);
    }
  });

  it("ids and files are unique; sha256, bytes and tags are well formed", () => {
    expect(new Set(catalog.entries.map((e) => e.id.toLowerCase())).size).toBe(catalog.entries.length);
    expect(new Set(catalog.entries.map((e) => e.file.toLowerCase())).size).toBe(catalog.entries.length);
    for (const e of catalog.entries) {
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.bytes, e.id).toBeGreaterThan(0);
      expect(e.bytes, e.id).toBeLessThanOrEqual(8.5e6);
      for (const t of e.tags) expect(t).toBe(t.toLowerCase());
    }
  });

  it("every model has real-world bounds in metres", () => {
    for (const e of catalog.entries) {
      if (e.kind !== "model") continue;
      expect(e.bounds_m.x * e.bounds_m.y * e.bounds_m.z, e.id).toBeGreaterThan(0);
    }
  });

  it("the director can find the common things it will ask for", () => {
    for (const t of ["ship", "crane", "truck", "house", "tree", "rock", "person", "train", "plane"]) {
      expect(catalog.search([t], undefined).length, t).toBeGreaterThan(0);
    }
  });

  it("LICENSES.md is in step with the manifest", () => {
    expect(readFileSync(path.join(dir, "LICENSES.md"), "utf8")).toBe(renderLicenses(catalog.entries));
  });
});
