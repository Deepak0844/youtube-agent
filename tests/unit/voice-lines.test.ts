import { describe, expect, it } from "vitest";
import { lineCacheKey, splitLines, tempoFitFactor } from "@/server/core/voice-lines";

const SAMPLES = {
  hi: "नमस्ते दोस्तों। आज हम सीखेंगे कि क्रिया कैसे काम करती है? बहुत बढ़िया॥ चलिए शुरू करें!",
  ta: "வணக்கம் நண்பர்களே. இன்று நாம் கற்றுக்கொள்வோம்? மிகவும் நன்று!",
  te: "నమస్కారం మిత్రులారా. ఈ రోజు మనం నేర్చుకుందాం? క్రమం చాలా బాగుంది! స్త్రీ విద్యార్థి.",
  ml: "നമസ്കാരം കൂട്ടുകാരേ. ഇന്ന് നമുക്ക് പഠിക്കാം? വളരെ നല്ലത്!",
  kn: "ನಮಸ್ಕಾರ ಸ್ನೇಹಿತರೇ. ಇಂದು ನಾವು ಕಲಿಯೋಣ? ಬಹಳ ಚೆನ್ನಾಗಿದೆ! ಕ್ರಿಯಾಪದ ಶಬ್ದ.",
} as const;
const strip = (s: string) => s.replace(/\s+/gu, "");
const cpLen = (s: string) => Array.from(s).length;

describe("splitLines", () => {
  it("split_keeps_every_character_and_order", () => {
    const text = "Hello world. How are you?\n\n  Fine!  ... \nत्यागपत्र।। ok ॥ 3.5 is a number.";
    const lines = splitLines(text, "en");
    expect(lines.map((l) => l.index)).toEqual(lines.map((_, i) => i));
    // "..." is punctuation-only here only if it stands alone; it was split off, so it is the one dropped piece
    expect(strip(lines.map((l) => l.text).join(""))).toBe(strip(text.normalize("NFC").replace("...", "")));
    expect(lines.some((l) => l.text === "3.5 is a number.")).toBe(true);
    expect(splitLines("  \n . ? \n", "en")).toEqual([]);
  });

  it("split_never_exceeds_max_chars_for_devanagari_tamil_telugu_malayalam_kannada", () => {
    for (const [lang, s] of Object.entries(SAMPLES)) {
      const long = Array(40).fill(s.replace(/[.?!।॥]/gu, "")).join(" ");
      for (const max of [7, 20, 64]) {
        const lines = splitLines(long, lang as "hi", max);
        expect(lines.length, lang).toBeGreaterThan(1);
        for (const l of lines) expect(cpLen(l.text), `${lang} ${max}`).toBeLessThanOrEqual(max);
        expect(strip(lines.map((l) => l.text).join(""))).toBe(strip(long.normalize("NFC")));
      }
    }
  });

  it("split_does_not_cut_combining_marks_or_zwj", () => {
    // No spaces at all, so every cut is a forced cut inside one long word.
    const samples = ["స్త్రీవిద్యార్థినిక్రమబద్ధం".repeat(8), "ಕ್ರಿಯಾಪದಶಬ್ದಕ್ಷೇತ್ರ".repeat(8), "क्षत्रिय‍क्ष‌त्र".repeat(8)];
    for (const s of samples) {
      for (const max of [6, 7, 9, 13]) {
        const lines = splitLines(s, "te", max);
        for (const l of lines) {
          const cps = Array.from(l.text);
          expect(cps[0]).not.toMatch(/[\p{M}‌‍]/u);
          expect(cps.at(-1)).not.toMatch(/[‍్್्]/u);
        }
        expect(lines.map((l) => l.text).join("")).toBe(s.normalize("NFC"));
      }
    }
  });

  it("normalises to NFC and hashes the line text", () => {
    const [l] = splitLines("é fin.", "en");
    expect(l!.text).toBe("é fin.");
    expect(l!.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("trims every piece, including hard-split ones", () => {
    expect(splitLines("aaaa  bbbb  cccc", "en", 6).map((l) => l.text)).toEqual(["aaaa", "bbbb", "cccc"]);
  });

  it("hard-splits at the last space before the limit", () => {
    expect(splitLines("aaaa bbbb cccc dddd", "en", 9).map((l) => l.text)).toEqual(["aaaa bbbb", "cccc dddd"]);
  });
});

describe("lineCacheKey", () => {
  const base: Parameters<typeof lineCacheKey>[0] = { text: "hi", voice: "v", model: "m", lang: "en", settings: { a: 1, b: "x" } };
  it("cache_key_changes_for_each_of_text_voice_model_lang_setting", () => {
    const k = lineCacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(lineCacheKey({ ...base, settings: { b: "x", a: 1 } })).toBe(k);
    const changes: Array<Partial<typeof base>> = [{ text: "hi!" }, { voice: "w" }, { model: "n" }, { lang: "hi" as const }, { settings: { a: 2, b: "x" } }, { settings: { a: 1 } }];
    for (const change of changes) expect(lineCacheKey({ ...base, ...change })).not.toBe(k);
  });
});

describe("tempoFitFactor", () => {
  it.each([
    [1, 1, 1, true],
    [0.5, 1, 1, true],
    [1.1, 1, 1.1, true],
    [1.15, 1, 1.15, true],
    [1.16, 1, 1.16, false],
  ])("clip %s in window %s", (clip, win, factor, fits) => {
    const r = tempoFitFactor(clip, win);
    expect(r.fits).toBe(fits);
    expect(r.factor).toBeCloseTo(factor, 10);
  });
  it("rejects bad input", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(() => tempoFitFactor(bad, 1)).toThrow();
      expect(() => tempoFitFactor(1, bad)).toThrow();
    }
  });
});
