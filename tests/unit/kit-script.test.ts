import { describe, expect, it } from "vitest";
import { splitByScript } from "../../remotion/kit/script";

describe("splitByScript", () => {
  it("splits mixed Latin and Devanagari", () => {
    expect(splitByScript("Hello नमस्ते world")).toEqual([
      { text: "Hello ", script: "latin" },
      { text: "नमस्ते ", script: "devanagari" },
      { text: "world", script: "latin" },
    ]);
  });
  it("detects Tamil, Telugu, Kannada, Malayalam", () => {
    expect(splitByScript("தமிழ்")).toEqual([{ text: "தமிழ்", script: "tamil" }]);
    expect(splitByScript("తెలుగు")[0]?.script).toBe("telugu");
    expect(splitByScript("ಕನ್ನಡ")[0]?.script).toBe("kannada");
    expect(splitByScript("മലയാളം")[0]?.script).toBe("malayalam");
  });
  it("keeps emoji, digits and punctuation with the previous run", () => {
    expect(splitByScript("தமிழ் 2025 🔥!")).toEqual([{ text: "தமிழ் 2025 🔥!", script: "tamil" }]);
    expect(splitByScript("ok 5 नमस्ते 🔥")).toEqual([
      { text: "ok 5 ", script: "latin" },
      { text: "नमस्ते 🔥", script: "devanagari" },
    ]);
  });
  it("handles empty and leading-neutral text", () => {
    expect(splitByScript("")).toEqual([]);
    expect(splitByScript("1. a")).toEqual([{ text: "1. a", script: "latin" }]);
  });
});
