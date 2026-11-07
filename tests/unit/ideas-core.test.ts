import { describe, expect, it } from "vitest";
import { cleanText, findSimilar, parseIdeaForm, similar, tokens } from "@/server/core/ideas";

describe("tokens and similar (ported from the old app)", () => {
  it("drops stop words and one-letter words", () => {
    expect([...tokens("How does a Bloom filter work?")].sort()).toEqual(["bloom", "filter", "work"]);
  });
  it("matches a rephrased topic", () => {
    expect(similar("Bloom filter explained", "How does a bloom filter work")).toBe(true);
  });
  it("does not match when the shared words are too few", () => {
    expect(similar("How a Bloom filter works", "Bloom filters: how they work")).toBe(false);
  });
  it("matches when the shorter topic is mostly inside the other", () => {
    expect(similar("binary search", "binary search algorithm explained simply")).toBe(true);
  });
  it("does not match different topics or empty text", () => {
    expect(similar("quick sort in 40 seconds", "how DNS works")).toBe(false);
    expect(similar("", "how DNS works")).toBe(false);
  });
  it("findSimilar returns the first known topic that matches, else null", () => {
    expect(findSimilar("binary search", ["how DNS works", "binary search tricks"])).toBe("binary search tricks");
    expect(findSimilar("merge sort", ["how DNS works"])).toBeNull();
  });
});

describe("cleanText", () => {
  it("removes control and hidden direction characters and collapses spaces", () => {
    expect(cleanText("  a\u0000b‮c ​d\n\n e  ", 50)).toBe("abc d e");
  });
  it("cuts to the limit", () => {
    expect(cleanText("x".repeat(500), 300)).toHaveLength(300);
  });
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseIdeaForm", () => {
  it("accepts a topic alone and fills the defaults", () => {
    expect(parseIdeaForm(form({ topic: "  How a hash map works  " }))).toEqual({ ok: true, value: { topic: "How a hash map works", hook: "", why: "", sources: [], score: 6 } });
  });
  it("rejects a topic that is too short or too long", () => {
    expect(parseIdeaForm(form({ topic: "short" })).ok).toBe(false);
    expect(parseIdeaForm(form({ topic: "x".repeat(201) })).ok).toBe(false);
  });
  it("keeps only https sources, one per line, at most 4", () => {
    const r = parseIdeaForm(form({ topic: "How a hash map works", sources: "https://a.example/x\nhttp://b.example\njavascript:alert(1)\nhttps://c.example\nhttps://d.example\nhttps://e.example\nhttps://f.example" }));
    expect(r).toMatchObject({ ok: true, value: { sources: ["https://a.example/x", "https://c.example", "https://d.example", "https://e.example"] } });
  });
  it("limits hook and why", () => {
    const r = parseIdeaForm(form({ topic: "How a hash map works", hook: "h".repeat(900), why: "w".repeat(900) }));
    expect(r.ok && r.value.hook.length).toBe(300);
    expect(r.ok && r.value.why.length).toBe(400);
  });
  it("rejects a score outside 2 to 10", () => {
    expect(parseIdeaForm(form({ topic: "How a hash map works", score: "11" })).ok).toBe(false);
    expect(parseIdeaForm(form({ topic: "How a hash map works", score: "8.5" }))).toMatchObject({ ok: true, value: { score: 8.5 } });
  });
});
