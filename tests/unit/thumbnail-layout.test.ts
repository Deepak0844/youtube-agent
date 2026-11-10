import { describe, expect, it } from "vitest";
import { THUMBNAIL_MAX_CHARS, THUMBNAIL_MAX_WORDS, thumbnailBoxes, thumbnailFontSize, thumbnailTitle } from "../../remotion/kit/thumbnailLayout";

describe("thumbnailTitle", () => {
  it("keeps a short title as it is and collapses spaces and control characters", () => {
    expect(thumbnailTitle("  Why   the sea\u0000 is salty ")).toBe("Why the sea is salty");
  });
  it("cuts a long title to a few words and never ends on a dangling filler word", () => {
    expect(thumbnailTitle("Why the sea is salty and the rivers are not")).toBe("Why the sea is salty");
    expect(thumbnailTitle("The history of the Roman empire in one hour")).toBe("The history of the Roman empire");
  });
  it("does not trim a title that was not cut, even if it ends on a filler word", () => {
    expect(thumbnailTitle("What is it for")).toBe("What is it for");
  });
  it("respects the word and character limits, also for scripts without spaces between letters of a word", () => {
    expect(thumbnailTitle("a b c d e f g h i j").split(" ").length).toBeLessThanOrEqual(THUMBNAIL_MAX_WORDS);
    expect(thumbnailTitle("x".repeat(200))).toBe("x".repeat(THUMBNAIL_MAX_CHARS)); // one very long word is cut to the limit, not dropped
    expect(thumbnailTitle("கடல் ஏன் உப்பாக இருக்கிறது")).toBe("கடல் ஏன் உப்பாக இருக்கிறது");
  });
  it("falls back to a plain line for an empty title", () => {
    expect(thumbnailTitle(undefined)).toBe("Watch this");
    expect(thumbnailTitle("\u0001 \u0002")).toBe("Watch this");
  });
});

describe("thumbnail sizes", () => {
  it("shorter titles are bigger, never under 64 px, and a picture makes the type smaller", () => {
    expect(thumbnailFontSize("Short", false)).toBeGreaterThan(thumbnailFontSize("A title that is fairly long indeed here", false));
    expect(thumbnailFontSize("x".repeat(200), false)).toBe(64);
    expect(thumbnailFontSize("Short", true)).toBeLessThan(thumbnailFontSize("Short", false));
  });
  it("the boxes stay inside the 1280x720 card and the picture does not overlap the text", () => {
    for (const has of [false, true]) {
      const b = thumbnailBoxes(has);
      for (const r of [b.text, ...(b.picture ? [b.picture] : [])]) expect(r.x + r.w <= 1280 && r.y + r.h <= 720 && r.x >= 0 && r.y >= 0).toBe(true);
      if (b.picture) expect(b.text.x + b.text.w).toBeLessThanOrEqual(b.picture.x);
    }
  });
});
