import { describe, expect, it } from "vitest";
import { renderLimitNote, scale3dSummary, scaleRows } from "@/server/core/scale3d-view";

const scene = {
  version: 1,
  objects: [
    { id: "person", kind: "person", label: "Person", height_m: 1.75, claim: { method: "average adult" } },
    { id: "tower", kind: "skyscraper", label: "Tower", height_m: 828, claim: { source_url: "https://example.com/t", quote: "828 m tall" } },
  ],
  beats: [
    { focus: "person", duration_s: 12, label: "A person", caption: "This is you." },
    { focus: "tower", range_m: [0, 828], duration_s: 10, label: "A tower", caption: "Now look up." },
  ],
  ruler: { show_ticks: true },
  loop_back: true,
};

describe("scale3dSummary", () => {
  it("orders beats with start times and names objects", () => {
    const r = scale3dSummary({ kind: "scale3d", scene });
    if (!r.ok) throw new Error("expected ok");
    expect(r.summary.beats.map((b) => b.startS)).toEqual([0, 12]);
    expect(r.summary.beats[1]).toMatchObject({ focus: "Tower", rangeLabel: "0 to 828 m" });
    expect(r.summary.beats[0]?.rangeLabel).toBe("whole object");
    expect(r.summary.totalS).toBe(22);
    expect(r.summary.loop).toBe(true);
    expect(r.summary.objects.map((o) => o.claimKind)).toEqual(["computed", "sourced"]);
  });
  it("gives a plain message for empty or invalid scenes", () => {
    for (const b of [null, {}, { kind: "scale3d", scene: { version: 1 } }]) {
      expect(scale3dSummary(b).ok).toBe(false);
    }
  });
});

describe("scaleRows", () => {
  it("shows height and source or method", () => {
    const rows = scaleRows([
      { label: "Crane", kind: "tower_crane", height_m: 60, source_url: "https://a.example/x", quote: "60 m" },
      { label: "Tree", kind: "tree", height_m: 20, method: "measured" },
    ]);
    expect(rows[0]).toEqual({ text: "Crane (tower crane): 60 m", kind: "sourced", detail: 'https://a.example/x - "60 m"' });
    expect(rows[1]).toMatchObject({ kind: "computed", detail: "measured" });
    expect(scaleRows(undefined)).toEqual([]);
  });
});

describe("renderLimitNote", () => {
  it("only warns below 900 s", () => {
    expect(renderLimitNote(600)).toContain("Settings > System");
    expect(renderLimitNote(900)).toBeNull();
  });
});
