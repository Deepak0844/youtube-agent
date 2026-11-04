import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadCatalog } from "@/shared/assets3d/catalog";
import { checkFile, sha256Hex } from "@/shared/assets3d/files";

const model = (over: Record<string, unknown> = {}) => ({
  kind: "model",
  id: "ship_a",
  name: "Cargo Ship",
  category: "vehicles",
  tags: ["ship", "cargo", "boat"],
  source: "poly.pizza",
  url: "https://poly.pizza/m/abc",
  download_url: "https://static.poly.pizza/abc.glb",
  author: "Someone",
  license: "CC0-1.0",
  license_evidence: 'page shows "Public Domain (CC0)"',
  file: "ship_a.glb",
  sha256: "a".repeat(64),
  bytes: 100,
  bounds_m: { x: 20, y: 30, z: 100 },
  up_axis: "y",
  default_scale: 1,
  pivot: "bottom",
  ...over,
});
const wrap = (...entries: unknown[]) => ({ version: 1, entries });

describe("loadCatalog", () => {
  it("accepts a valid model and finds it by id", () => {
    const c = loadCatalog(wrap(model()));
    expect(c.getById("ship_a")?.name).toBe("Cargo Ship");
    expect(c.getById("nope")).toBeUndefined();
  });

  it("rejects a licence that is not CC0 or Public Domain", () => {
    for (const license of ["CC-BY-4.0", "CC-BY 3.0", "MIT", "unknown", ""]) {
      expect(() => loadCatalog(wrap(model({ license })))).toThrow();
    }
    expect(() => loadCatalog(wrap(model({ license: "Public Domain" })))).not.toThrow();
  });

  it("rejects duplicate ids, empty evidence, upper-case tags and a bad sha256", () => {
    expect(() => loadCatalog(wrap(model(), model()))).toThrow(/duplicate/);
    expect(() => loadCatalog(wrap(model({ license_evidence: "" })))).toThrow();
    expect(() => loadCatalog(wrap(model({ tags: ["Ship"] })))).toThrow();
    expect(() => loadCatalog(wrap(model({ sha256: "xyz" })))).toThrow();
  });

  it("models need real-world bounds; hdri and texture entries do not", () => {
    expect(() => loadCatalog(wrap(model({ bounds_m: undefined })))).toThrow();
    const hdri = { ...model({ kind: "hdri", category: "hdri", file: "sky.hdr" }), bounds_m: undefined, up_axis: undefined };
    expect(() => loadCatalog(wrap(hdri))).not.toThrow();
  });
});

describe("search", () => {
  const c = loadCatalog(
    wrap(
      model({ id: "ship_a", tags: ["ship", "cargo", "boat"] }),
      model({ id: "boat_b", name: "Rowing Boat", tags: ["boat"] }),
      model({ id: "tree_c", name: "Pine", category: "nature", tags: ["tree", "pine", "boat"] }),
      model({ id: "crane_d", name: "Crane", tags: ["crane", "cargo"] }),
    ),
  );

  it("ranks by tag overlap", () => {
    expect(c.search(["cargo", "ship", "boat"]).map((e) => e.id)).toEqual(["ship_a", "boat_b", "crane_d", "tree_c"]);
  });

  it("is case-insensitive, skips entries with no overlap, and can filter by category", () => {
    expect(c.search(["CRANE"]).map((e) => e.id)).toEqual(["crane_d"]);
    expect(c.search(["rocket"])).toEqual([]);
    expect(c.search(["boat"], "nature").map((e) => e.id)).toEqual(["tree_c"]);
  });

  it("a name word counts as a tag", () => {
    expect(c.search(["rowing"]).map((e) => e.id)).toEqual(["boat_b"]);
  });
});

describe("checkFile", () => {
  it("reports ok, missing and bad", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "a3d-test-"));
    const buf = Buffer.from("hello");
    await writeFile(path.join(dir, "a.glb"), buf);
    const e = { file: "a.glb", bytes: buf.length, sha256: sha256Hex(buf) };
    expect(await checkFile(dir, e)).toBe("ok");
    expect(await checkFile(dir, { ...e, file: "b.glb" })).toBe("missing");
    expect(await checkFile(dir, { ...e, sha256: "0".repeat(64) })).toBe("bad");
  });
});
