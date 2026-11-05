import { loadCatalog } from "@/shared/assets3d/catalog";

// A small fake catalogue for director and render tests: valid manifest entries, no files needed.
const entry = (id: string, name: string, category: string, tags: string[], y: number) => ({
  kind: "model" as const, id, name, category, tags, source: "poly.pizza", url: `https://poly.pizza/m/${id}`, download_url: `https://static.poly.pizza/${id}.glb`,
  author: "Quaternius", license: "CC0-1.0", license_evidence: "page shows Public Domain (CC0)", file: `${id}.glb`,
  sha256: "a".repeat(64), source_sha256: "a".repeat(64), bytes: 1000, bounds_m: { x: 4, y, z: 8 }, up_axis: "y", default_scale: 1, pivot: "bottom",
});

export const FAKE_ENTRIES = [
  entry("pp_ship", "Cargo Ship", "vehicles", ["ship", "boat", "vessel"], 20),
  entry("pp_crane", "Tower Crane", "props", ["crane", "construction"], 60),
  entry("pp_tower", "Glass Tower", "buildings", ["tower", "building", "skyscraper"], 150),
  entry("pp_worker", "Worker", "people", ["person", "people", "worker"], 1.8),
  entry("pp_palm", "Palm Tree", "nature", ["tree", "palm"], 8),
  entry("pp_truck", "Dump Truck", "vehicles", ["truck", "vehicle"], 4),
];

export const fakeCatalog = () => loadCatalog({ version: 1, entries: FAKE_ENTRIES });
