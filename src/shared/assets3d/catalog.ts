import { Manifest, type Entry3d } from "./schema";

export type Catalog3d = {
  entries: readonly Entry3d[];
  getById(id: string): Entry3d | undefined;
  search(tags: readonly string[], category?: string): Entry3d[];
};

// Checks the manifest and builds the lookup. Throws on a bad manifest or a duplicate id.
export function loadCatalog(raw: unknown): Catalog3d {
  const { entries } = Manifest.parse(raw);
  const byId = new Map<string, Entry3d>();
  for (const e of entries) {
    if (byId.has(e.id)) throw new Error(`duplicate asset id: ${e.id}`);
    byId.set(e.id, e);
  }
  return {
    entries,
    getById: (id) => byId.get(id),
    search: (tags, category) => searchEntries(entries, tags, category),
  };
}

// Ranked by how many wanted tags an entry has (the name also counts as a tag). Entries with no overlap are left out.
export function searchEntries(entries: readonly Entry3d[], tags: readonly string[], category?: string): Entry3d[] {
  const want = new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const scored: { e: Entry3d; score: number }[] = [];
  for (const e of entries) {
    if (category && e.category !== category) continue;
    const have = new Set([...e.tags, ...e.name.toLowerCase().split(/[^a-z0-9]+/)]);
    let score = 0;
    for (const t of want) if (have.has(t)) score += 1;
    if (score > 0) scored.push({ e, score });
  }
  // Same score: fewer tags first (a tighter match), then id so the order is stable.
  scored.sort((a, b) => b.score - a.score || a.e.tags.length - b.e.tags.length || a.e.id.localeCompare(b.e.id));
  return scored.map((s) => s.e);
}
