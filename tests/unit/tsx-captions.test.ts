import { describe, expect, it } from "vitest";
import { tsxCaptionsStatus, tsxCaptionWords } from "@/server/core/tsx-captions";
import { captionAt } from "../../remotion/kit/tsx-caption-page";

const W = (word: string, startS: number, endS: number) => ({ word, startS, endS });

describe("captionAt", () => {
  const words = [W("One", 0, 0.4), W("two", 0.4, 0.8), W("three", 0.8, 1.2), W("four", 1.2, 1.6)];
  it("pages 3 words at a time and highlights the spoken word", () => {
    expect(captionAt(words, 0.1)).toEqual({ words: ["One", "two", "three"], active: 0 });
    expect(captionAt(words, 0.9)).toEqual({ words: ["One", "two", "three"], active: 2 });
    expect(captionAt(words, 1.3)).toEqual({ words: ["four"], active: 0 });
  });
  it("shows nothing before the first word and after the last page holds", () => {
    expect(captionAt(words, -1)).toBeNull();
    expect(captionAt(words, 1.9)).toBeNull();
  });
});

describe("tsxCaptionWords / tsxCaptionsStatus", () => {
  it("strips override braces and backslashes and drops unusable words", () => {
    expect(tsxCaptionWords([W("a{\\b1}b", 0, 1), W("", 0, 1), W("x", NaN, 1), W("y", 2, 1)])).toEqual([W("ab1b", 0, 1)]);
  });
  it("says why captions are missing", () => {
    expect(tsxCaptionsStatus([W("hi", 0, 1)])).toBe("in_render");
    expect(tsxCaptionsStatus(undefined)).toMatch(/^none \(no word times/);
    expect(tsxCaptionsStatus([])).toMatch(/^none \(/);
    expect(tsxCaptionsStatus([W("", 0, 1)])).toMatch(/^none \(the stored word times are unusable\)/);
  });
});
