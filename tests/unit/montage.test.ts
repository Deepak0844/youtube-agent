import { describe, expect, it } from "vitest";
import type { ClipCandidate } from "@/server/core/clip-rank";
import { planFootage, scoreFootage, type FootageSlot } from "@/server/core/montage-footage";
import { montageArgs, montageProblem, type MontageEdit } from "@/server/core/montage-edit";

const clip = (o: Partial<ClipCandidate> = {}): ClipCandidate => ({ title: "ocean waves crashing", url: "https://cdn/a.mp4", width: 1920, height: 1080, durationS: 12, bytes: 5e6, licence: "Pixabay Content License", credit: "Video by A on Pixabay", pageUrl: null, text: "sea water", ...o });
const slot = (o: Partial<FootageSlot> = {}): FootageSlot => ({ id: "s1", query: ["ocean", "waves"], seconds: 6, ...o });

describe("montage footage (M1)", () => {
  it("scores title words double and rejects clips that cannot serve the slot", () => {
    expect(scoreFootage(slot(), clip())).toBe(1);
    expect(scoreFootage(slot({ seconds: 20 }), clip())).toBeNull(); // too short
    expect(scoreFootage(slot(), clip({ licence: "  " }))).toBeNull();
    expect(scoreFootage(slot(), clip({ height: 480 }))).toBeNull();
    expect(scoreFootage(slot(), clip({ bytes: 60e6 }))).toBeNull();
    expect(scoreFootage(slot({ query: [] }), clip())).toBeNull();
  });
  it("uses each clip once and reports a slot with no good match", () => {
    const found = new Map([["s1", [clip()]], ["s2", [clip(), clip({ url: "https://cdn/b.mp4", title: "ocean waves" })]], ["s3", [clip({ title: "city traffic", text: "cars", url: "https://cdn/c.mp4" })]]]);
    const p = planFootage([slot(), slot({ id: "s2" }), slot({ id: "s3" })], found);
    expect(p.picks.map((x) => [x.slotId, x.cand.url])).toEqual([["s1", "https://cdn/a.mp4"], ["s2", "https://cdn/b.mp4"]]);
    expect(p.unfilled).toEqual(["s3"]);
    expect(p.picks[0]!.licenceLine).toBe("Video by A on Pixabay");
  });
});

const edit = (o: Partial<MontageEdit> = {}): MontageEdit => ({ clips: [{ file: "a.mp4", durationS: 10, slotS: 4 }, { file: "b.mp4", durationS: 8, slotS: 3 }], grade: "film", width: 1920, height: 1080, fadeS: 0.2, out: "film.mp4", ...o });

describe("montage edit (M2)", () => {
  it("trims from the middle, cover-fits, grades every clip alike and dips at the inner seam only", () => {
    const g = montageArgs(edit()).join(" ");
    expect(g).toContain("trim=start=3.000:duration=4.000");
    expect(g).toContain("trim=start=2.500:duration=3.000");
    expect(g).toContain("scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080");
    expect((g.match(/colorbalance=rs=0.03/g) ?? []).length).toBe(2);
    expect(g).toContain("fade=t=out:st=3.800:d=0.200[v0]");
    expect(g).toContain("fade=t=in:st=0:d=0.200[v1]");
    expect(g).not.toContain("fade=t=out:st=2.800");
    expect(g).toContain("concat=n=2:v=1:a=0[outv]");
  });
  it("refuses a bad edit with a plain sentence", () => {
    expect(montageProblem(edit({ clips: [] }))).toMatch(/no clips/);
    expect(montageProblem(edit({ clips: [{ file: "../x.mp4", durationS: 9, slotS: 3 }] }))).toMatch(/file name/);
    expect(montageProblem(edit({ clips: [{ file: "a.mp4", durationS: 2, slotS: 3 }] }))).toMatch(/shorter/);
    expect(montageProblem(edit({ fadeS: 5 }))).toMatch(/fade/);
    expect(() => montageArgs(edit({ out: "-bad.mp4" }))).toThrow(/output name/);
  });
});
