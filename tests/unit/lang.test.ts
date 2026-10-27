import { describe, expect, it } from "vitest";
import { LANGS, draftInstruction, wordCount, wordRange } from "@/server/core/lang";

describe("lang", () => {
  it("all_six_languages_are_defined", () => {
    expect([...LANGS]).toEqual(["en", "hi", "ta", "te", "ml", "kn"]);
    for (const l of LANGS) expect(wordRange(l).min).toBeLessThan(wordRange(l).max);
  });
  it("english range is 60-150", () => expect(wordRange("en")).toEqual({ min: 60, max: 150 }));
  it("indic_words_are_counted_by_whitespace_not_by_regex", () => {
    expect(wordCount("नमस्ते दुनिया कैसे हैं")).toBe(4);
    expect(wordCount("வணக்கம் உலகம்  எப்படி")).toBe(3);
    expect(wordCount("నమస్కారం ప్రపంచం")).toBe(2);
    expect(wordCount("നമസ്കാരം ലോകം\nസുഖമാണോ")).toBe(3);
    expect(wordCount("ನಮಸ್ಕಾರ ಜಗತ್ತು")).toBe(2);
    expect(wordCount("  ")).toBe(0);
  });
  it("word_ranges_scale_with_speaking_rate", () => {
    const slow = wordRange("en", 1.35);
    expect(slow).toEqual({ min: 30, max: 75 });
    expect(wordRange("ml").max).toBeLessThan(wordRange("en").max);
    expect(() => wordRange("en", 0)).toThrow();
  });
  it("prompt_and_draft_check_follow_the_language", () => {
    expect(draftInstruction("en")).toBe("");
    expect(draftInstruction("hi")).toContain("Hindi");
    expect(draftInstruction("hi")).toContain("Devanagari");
    expect(draftInstruction("kn")).toContain("Kannada");
    expect(draftInstruction("kn")).toContain(`${wordRange("kn").min}-${wordRange("kn").max}`);
  });
});
