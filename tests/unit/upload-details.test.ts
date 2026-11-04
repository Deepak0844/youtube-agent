import { describe, expect, it } from "vitest";
import { defaultDetails, storedDetailsProblem, validateUploadDetails } from "@/server/core/upload-details";

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
  it("needs an explicit made-for-kids and synthetic choice", () => {
    expect(validateUploadDetails({ ...good, made_for_kids: undefined }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, made_for_kids: "no" }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, synthetic_content: undefined }).ok).toBe(false);
  });
  it("checks category and language", () => {
    expect(validateUploadDetails({ ...good, category_id: 0 }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, category_id: "27" }).ok).toBe(false);
    expect(validateUploadDetails({ ...good, language: "English" }).ok).toBe(false);
  });
});

describe("storedDetailsProblem", () => {
  it("passes older bodies without detail fields and fails a broken new one", () => {
    expect(storedDetailsProblem({ visibility: "private" })).toBeNull();
    expect(storedDetailsProblem({ ...good, title: "" })).toMatch(/not valid/);
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
