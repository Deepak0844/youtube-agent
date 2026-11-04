import { describe, expect, it } from "vitest";
import { approvalDetailsProblem, defaultDetails, storedDetailsProblem, validateUploadDetails } from "@/server/core/upload-details";

const good = { title: "Why the sky is blue", description: "Because of light.", tags: ["sky", "science"], category_id: 27, language: "en", made_for_kids: false, synthetic_content: false };

describe("validateUploadDetails", () => {
  it("accepts a good set and trims", () => {
    const r = validateUploadDetails({ ...good, title: "  Hi  " });
    expect(r.ok && r.value.title).toBe("Hi");
  });
  it("refuses a title over 100 characters, or with angle brackets or a line break", () => {
    for (const title of ["x".repeat(101), "a <b> c", "a\nb", ""]) expect(validateUploadDetails({ ...good, title }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, title: "x".repeat(100) }).ok).toBe(true);
  });
  it("counts description bytes, not characters", () => {
    expect(validateUploadDetails({ ...good, description: "a".repeat(5000) }).ok).toBe(true);
    expect(validateUploadDetails({ ...good, description: "é".repeat(2501) }).ok).toBe(false);
  });
  it("limits tags to 500 characters in total and refuses angle brackets", () => {
    expect(validateUploadDetails({ ...good, tags: Array.from({ length: 6 }, () => "a".repeat(80)) }).ok).toBe(true);
    expect(validateUploadDetails({ ...good, tags: Array.from({ length: 7 }, () => "a".repeat(80)) }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, tags: ["<x>"] }).ok).toBe(false);
  });
  it("refuses angle brackets in the description", () => {
    expect(validateUploadDetails({ ...good, description: "a <b>" }).ok).toBe(false);
  });
  it("refuses hidden and direction-changing characters in title and tags", () => {
    for (const ch of ["\u2028", "\u2029", "\u0085", "\u202e", "\u2066", "\u200b", "\u200d", "\ufeff"]) {
      expect(validateUploadDetails({ ...good, title: `a${ch}b` }).ok).toBe(false);
      expect(validateUploadDetails({ ...good, tags: [`a${ch}b`] }).ok).toBe(false);
    }
  });
  it("counts the quotes YouTube adds around a tag with a space", () => {
    const plain = Array.from({ length: 6 }, (_, i) => `${i}${"a".repeat(78)}`); // 6 x 79 + 5 commas = 479
    expect(validateUploadDetails({ ...good, tags: plain }).ok).toBe(true);
    const spaced = Array.from({ length: 6 }, (_, i) => `${i} ${"a".repeat(77)}`); // 6 x (79 + 2) + 5 = 491
    expect(validateUploadDetails({ ...good, tags: spaced }).ok).toBe(true);
    expect(validateUploadDetails({ ...good, tags: [...spaced, "a b c d"] }).ok).toBe(false);
  });
  it("needs an explicit made-for-kids and synthetic choice", () => {
    expect(validateUploadDetails({ ...good, made_for_kids: undefined }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, made_for_kids: "no" }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, synthetic_content: undefined }).ok).toBe(false);
  });
  it("checks category and language", () => {
    expect(validateUploadDetails({ ...good, category_id: 0 }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, category_id: "27" }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, language: "English" }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, language: "" }).ok).toBe(false);
  });
});

describe("storedDetailsProblem", () => {
  it("passes older bodies without detail fields and fails a broken new one", () => {
    expect(storedDetailsProblem({ visibility: "private" })).toBeNull();
    expect(storedDetailsProblem({ ...good, title: "" })).toMatch(/not valid/);
  });
});

describe("approvalDetailsProblem", () => {
  it("refuses a title-only legacy body and accepts the full set", () => {
    expect(approvalDetailsProblem({ title: "t", visibility: "private", publish_at: null })).toMatch(/save the upload details/);
    expect(approvalDetailsProblem({ ...good, visibility: "private", publish_at: null })).toBeNull();
  });
});

describe("defaultDetails", () => {
  it("pre-selects No for kids and category 27 with no channel", () => {
    const d = defaultDetails({ channel: null, titles: null, videoLanguage: "ta", scriptTitle: "T" });
    expect(d).toMatchObject({ made_for_kids: false, category_id: 27, language: "ta", title: "T", synthetic_content: false });
  });
  it("takes the channel's choices", () => {
    const d = defaultDetails({ channel: { categoryId: 28, language: "hi", madeForKids: true, synthetic: true }, titles: { title: "A", description: "D", tags: ["t"] }, videoLanguage: "en", scriptTitle: "T" });
    expect(d).toMatchObject({ made_for_kids: true, category_id: 28, language: "hi", title: "A", synthetic_content: true });
  });
});
