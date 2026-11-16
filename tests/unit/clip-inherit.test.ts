import { describe, expect, it } from "vitest";
import { claimStatedIn, clipBeats, clipTitle, inheritClipScript } from "@/server/core/clip-inherit";
import type { Claim } from "@/server/core/script-contract";

const w = (text: string, from = 0) => text.split(" ").map((word, i) => ({ word, startS: from + i * 0.3, endS: from + i * 0.3 + 0.25 }));
const sourced = (text: string): Claim => ({ text, kind: "sourced", source_url: "https://example.org/a", quote: "q" });
const computed = (text: string): Claim => ({ text, kind: "computed", method: "m" });

const clip = {
  hook: "Blue light scatters ten times more than red light.",
  words: [...w("Blue light scatters ten times more than red light."), ...w("That is why the sky looks blue at noon.", 4)],
};

describe("claimStatedIn", () => {
  it("is true when most of the claim's content words are spoken in the clip", () => {
    expect(claimStatedIn(sourced("Blue light scatters ten times more than red light"), clip.words.map((x) => x.word).join(" "))).toBe(true);
  });
  it("is false for a claim the clip never states, and for a claim with no content words", () => {
    const n = clip.words.map((x) => x.word).join(" ");
    expect(claimStatedIn(sourced("Ozone absorbs ultraviolet radiation in the stratosphere"), n)).toBe(false);
    expect(claimStatedIn(sourced("it is a no"), n)).toBe(false);
  });
  it("matches numbers even when short", () => {
    expect(claimStatedIn(sourced("The sun is 93 million miles away"), "The sun is 93 million miles away from us")).toBe(true);
  });
});

describe("clipTitle", () => {
  it("cuts a long hook at a word, drops the final full stop and never returns an empty title", () => {
    expect(clipTitle("Blue light scatters ten times more than red light.")).toBe("Blue light scatters ten times more than red light");
    const long = clipTitle("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(" ")).toBe(false);
    expect(clipTitle("...")).toBe("Clip");
  });
});

describe("clipBeats", () => {
  it("makes one beat per spoken sentence with clip-relative times", () => {
    const b = clipBeats(clip);
    expect(b.map((x) => x.id)).toEqual(["b1", "b2"]);
    expect(b[0]!.text).toBe("Blue light scatters ten times more than red light.");
    expect(b[0]!.est_start).toBe(0);
    expect(b[1]!.est_start).toBeGreaterThanOrEqual(4);
    expect(b[1]!.est_end).toBeGreaterThan(b[1]!.est_start);
  });
  it("a clip with no words has no beats", () => {
    expect(clipBeats({ words: [] })).toEqual([]);
  });
});

describe("inheritClipScript", () => {
  const source = { claims: [sourced("Blue light scatters ten times more than red light"), computed("Ozone absorbs ultraviolet radiation in the stratosphere")] };
  it("keeps only the claims the clip states and counts the rest", () => {
    const r = inheritClipScript(source, clip);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.script.evidence).toHaveLength(1);
    expect(r.value.script.evidence[0]!.text).toMatch(/Blue light/);
    expect(r.value.leftOutClaims).toBe(1);
    expect(r.value.script.narration).toBe(clip.words.map((x) => x.word).join(" "));
    expect(r.value.script.title).toBe("Blue light scatters ten times more than red light");
  });
  it("never invents a claim: a clip stating nothing gets no evidence", () => {
    const r = inheritClipScript({ claims: [computed("Mount Everest is 8849 metres tall")] }, clip);
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.script.evidence).toEqual([]);
  });
  it("refuses a clip with no words in plain words", () => {
    expect(inheritClipScript(source, { hook: "x", words: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/no spoken words/) });
  });
});
