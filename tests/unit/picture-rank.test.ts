import { describe, expect, it } from "vitest";
import { MIN_SCORE, pickBest, scoreCandidate, type PictureCandidate } from "@/server/core/picture-rank";

const cand = (over: Partial<PictureCandidate> = {}): PictureCandidate => ({
  source: "wikimedia", title: "Engine cutaway", url: "https://upload.wikimedia.org/x.jpg", width: 2000, height: 1500, mime: "image/jpeg",
  licence: "CC0", credit: "c", pageUrl: "https://commons.wikimedia.org/wiki/File:x.jpg", text: "petrol engine cutaway", ...over,
});
const brief = { search: ["petrol engine cutaway"], visual: "cutaway diagram of a petrol engine" };

describe("scoreCandidate", () => {
  it("rejects too small, odd aspect and wrong formats", () => {
    expect(scoreCandidate(brief, cand({ width: 900, height: 700 }))).toBeNull();
    expect(scoreCandidate(brief, cand({ width: 3000, height: 1000 }))).toBeNull(); // 3.0
    expect(scoreCandidate(brief, cand({ width: 1000, height: 3000 }))).toBeNull(); // 0.33
    for (const mime of ["image/svg+xml", "image/gif", "image/tiff", "application/pdf"]) expect(scoreCandidate(brief, cand({ mime }))).toBeNull();
    expect(scoreCandidate(brief, cand({ mime: "image/png" }))).not.toBeNull();
    expect(scoreCandidate(brief, cand({ mime: "image/webp" }))).not.toBeNull();
  });
  it("drops a portrait of a person unless the brief names a person", () => {
    const p = cand({ title: "John Smith portrait 2019", text: "petrol engine inventor" });
    expect(scoreCandidate(brief, p)).toBeNull();
    expect(scoreCandidate({ search: ["John Smith inventor portrait"], visual: "portrait of John Smith" }, p)).not.toBeNull();
  });
  it("prefers the diagram when the brief asks for a diagram", () => {
    const diagram = cand({ title: "Petrol engine cutaway diagram", text: "diagram" });
    const photo = cand({ title: "Petrol engine in a car", text: "car bonnet" });
    expect(scoreCandidate(brief, diagram)!).toBeGreaterThan(scoreCandidate(brief, photo)!);
  });
});

describe("person rules", () => {
  it("two capitalised words (Golden Gate) do not count as naming a person", () => {
    const b = { search: ["Golden Gate bridge"], visual: "the Golden Gate bridge at sunrise" };
    expect(scoreCandidate(b, cand({ title: "Golden Gate portrait view", text: "Golden Gate bridge" }))).toBeNull();
  });
  it("refuses person-tagged Pixabay hits unless the brief is about people", () => {
    const hit = cand({ source: "pixabay", title: "engine mechanic", text: "engine, man, workshop, petrol" });
    expect(scoreCandidate(brief, hit)).toBeNull();
    expect(scoreCandidate({ search: ["mechanic man petrol engine"], visual: "a man repairing a petrol engine" }, hit)).not.toBeNull();
    expect(scoreCandidate(brief, cand({ source: "pixabay", text: "petrol engine cutaway, metal" }))).not.toBeNull();
  });
});

describe("pickBest", () => {
  it("picks the matching candidate over a stronger-looking but unrelated one", () => {
    const match = cand({ title: "Petrol engine cutaway", width: 1600, height: 1200 });
    const other = cand({ title: "Sunset over the sea", text: "sea", width: 4000, height: 3000, url: "https://upload.wikimedia.org/y.jpg" });
    expect(pickBest(brief, [other, match])?.cand).toBe(match);
  });
  it("returns null when everything is a weak match (threshold)", () => {
    const weak = cand({ title: "Engine room of a ship", text: "ship" });
    expect(scoreCandidate(brief, weak)!).toBeLessThan(MIN_SCORE);
    expect(pickBest(brief, [weak])).toBeNull();
    expect(pickBest(brief, [])).toBeNull();
  });
  it("is stable: equal scores keep input order", () => {
    const a = cand({ url: "https://upload.wikimedia.org/a.jpg" });
    const b = cand({ url: "https://upload.wikimedia.org/b.jpg" });
    expect(pickBest(brief, [a, b])?.cand).toBe(a);
  });
});
