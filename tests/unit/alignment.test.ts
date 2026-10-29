import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { captionsBody, estimateTimings, mapToScript, pickTimingsKind, splitForAlignment, type Recognised } from "@/server/core/alignment";
import { buildChildEnv, type ChildSpec } from "@/server/render/child";
import { alignChunk, AlignError, type ChildRunner } from "@/server/render/whisper";
import en from "../fixtures/align/en.json";

const rec = (word: string, startS: number, endS: number, p = 0.9): Recognised => ({ word, startS, endS, p });
const ok = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };
const whisperJson = (ws: Recognised[]): string =>
  JSON.stringify({ transcription: ws.map((w) => ({ text: ` ${w.word}`, offsets: { from: w.startS * 1000, to: w.endS * 1000 }, tokens: [{ p: w.p, id: 100 }, { p: 0.1, id: 50400 }] })) });
const fakeRunner = (ws: Recognised[], seen: ChildSpec[] = []): ChildRunner => async (spec) => {
  seen.push(spec);
  writeFileSync(spec.args[spec.args.indexOf("-of") + 1] + ".json", whisperJson(ws));
  return ok;
};

describe("mapToScript", () => {
  it("script_spelling_wins_over_recogniser_spelling", () => {
    const r = mapToScript(en.script, en.recognised);
    expect(r.words.map((w) => w.word)).toEqual(en.script);
    expect(r.words[1]!.startS).toBe(0.7);
    expect(r.stats).toEqual({ scriptWords: 9, recognisedWords: 8, matched: 8 });
  });

  it("unrecognised_words_interpolated_monotone_no_overlap", () => {
    const r = mapToScript(en.script, en.recognised); // "we" is missing; "Hello" overlap case below
    const we = r.words[3]!;
    expect(we.source).toBe("interpolated");
    expect(we.startS).toBeGreaterThanOrEqual(1.8);
    expect(we.endS).toBeLessThanOrEqual(2.3);
    const o = mapToScript(["a", "b", "c"], [rec("a", 0, 1), rec("b", 0.5, 1.5), rec("c", 1.2, 2)]);
    for (let i = 1; i < o.words.length; i++) expect(o.words[i]!.startS).toBeGreaterThanOrEqual(o.words[i - 1]!.endS);
    for (const w of [...r.words, ...o.words]) expect(w.endS).toBeGreaterThanOrEqual(w.startS);
  });

  it("loop_of_three_equal_words_flagged", () => {
    const r = mapToScript(["go", "go", "go", "now"], [rec("go", 0, 0.3), rec("go", 0.3, 0.6), rec("go", 0.6, 0.9), rec("now", 0.9, 1.2)]);
    expect(r.words.slice(0, 3).every((w) => w.flags.includes("loop"))).toBe(true);
    expect(r.words[3]!.flags).not.toContain("loop");
  });

  it("flags_low_confidence_too_short_too_long", () => {
    const r = mapToScript(["a", "b", "c"], [rec("a", 0, 0.5, 0.3), rec("b", 0.5, 0.52), rec("c", 0.52, 3)]);
    expect(r.words.map((w) => w.flags)).toEqual([["low_confidence"], ["too_short"], ["too_long"]]);
  });

  it("count_mismatch_over_15_percent_flags_chunk", () => {
    const script = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const bad = mapToScript(script, script.slice(0, 8).map((w, i) => rec(w, i, i + 0.5)));
    expect(bad.words.every((w) => w.flags.includes("count_mismatch"))).toBe(true);
    const fine = mapToScript(script, script.slice(0, 9).map((w, i) => rec(w, i, i + 0.5)));
    expect(fine.words.some((w) => w.flags.includes("count_mismatch"))).toBe(false);
  });
});

describe("captions", () => {
  it("estimated_spreads_evenly_and_is_flagged_approximate", () => {
    const w = estimateTimings(["a", "b", "c", "d"], 8);
    expect(w.map((x) => [x.startS, x.endS])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8]]);
    const b = captionsBody("estimated", w);
    expect(b).toMatchObject({ timings_kind: "estimated", approximate: true, needs_check: true });
  });

  it("order_native_aligned_estimated_and_none_refused", () => {
    expect(pickTimingsKind(["estimated", "aligned"])).toBe("aligned");
    expect(pickTimingsKind(["aligned", "native"])).toBe("native");
    expect(() => pickTimingsKind(["none"])).toThrow();
  });

  it("splits_lines_into_chunks_of_at_most_15s", () => {
    expect(splitForAlignment(["a", "b", "c", "d"], [6, 8, 7, 20])).toEqual([[0, 1], [2], [3]]);
  });
});

describe("alignChunk", () => {
  it.each(["te", "kn", "ml"] as const)("telugu_kannada_malayalam_aligned_always_flagged_language_unreliable (%s)", async (lang) => {
    const b = await alignChunk({ runChild: fakeRunner(en.recognised), modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 5, lang, script: en.script });
    expect(b.timings_kind).toBe("aligned");
    expect(b.words.every((w) => w.flags.includes("language_unreliable"))).toBe(true);
    expect(b).toMatchObject({ approximate: true, needs_check: true });
  });

  it("english_aligned_is_not_approximate_when_clean", async () => {
    const script = ["a", "b"];
    const b = await alignChunk({ runChild: fakeRunner([rec("a", 0, 0.5), rec("b", 0.5, 1)]), modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 1, lang: "en", script });
    expect(b).toMatchObject({ timings_kind: "aligned", approximate: false, needs_check: false });
  });

  it("empty_recognition_falls_back_to_estimated_not_to_silence", async () => {
    const b = await alignChunk({ runChild: fakeRunner([]), modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 4, lang: "en", script: ["a", "b"] });
    expect(b.timings_kind).toBe("estimated");
    expect(b.words).toHaveLength(2);
    expect(b.approximate).toBe(true);
  });

  it("child_gets_no_secret_env", async () => {
    const seen: ChildSpec[] = [];
    await alignChunk({ runChild: fakeRunner([rec("a", 0, 1)], seen), modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 1, lang: "en", script: ["a"] });
    const s = seen[0]!;
    expect(s.envAllow).toEqual(["PATH"]);
    expect(Object.keys(buildChildEnv(s.envAllow, { PATH: "/bin", DATABASE_URL: "x", ANTHROPIC_API_KEY: "y" }))).toEqual(["PATH"]);
    expect(s.args).toEqual(expect.arrayContaining(["-l", "en", "-ml", "1", "-sow", "-ojf"]));
    expect([s.timeoutMs, s.maxOutputBytes]).toEqual([120_000, 5 * 1024 * 1024]);
  });

  it("chunk_over_30s_refused", async () => {
    const seen: ChildSpec[] = [];
    await expect(alignChunk({ runChild: fakeRunner([], seen), modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 30.5, lang: "en", script: ["a"] })).rejects.toBeInstanceOf(AlignError);
    expect(seen).toHaveLength(0);
  });

  it("a_failed_child_is_an_error_not_a_silent_estimate", async () => {
    const run: ChildRunner = async () => ({ ...ok, code: 1 });
    await expect(alignChunk({ runChild: run, modelPath: "/m.bin" }, { audioPath: "/a.wav", durationS: 1, lang: "en", script: ["a"] })).rejects.toBeInstanceOf(AlignError);
  });
});
