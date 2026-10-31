import { describe, expect, it } from "vitest";
import { FINDING_DEFAULTS, parseBlackdetect, parseFfprobe, parseFreezedetect, parseLoudness, qaFindings, type Scan } from "@/server/core/qa-findings";

const good: Scan = {
  facts: { durationS: 30, sizeBytes: 5e6, video: { codec: "h264", width: 1080, height: 1920, fps: 30 }, audioCodec: "aac" },
  blackRuns: [], freezeRuns: [], lufs: -16, truePeakDb: -3, meanDb: -20, narrationS: 30,
};
const ids = (s: Scan, sev?: string) => qaFindings(s).filter((f) => !sev || f.severity === sev).map((f) => f.id);

describe("parsers", () => {
  it("ffprobe json", () => {
    const f = parseFfprobe(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, r_frame_rate: "30000/1001" }, { codec_type: "audio", codec_name: "aac" }], format: { duration: "12.5", size: "999" } }));
    expect(f).toMatchObject({ durationS: 12.5, sizeBytes: 999, audioCodec: "aac", video: { codec: "h264", width: 1080 } });
    expect(f.video?.fps).toBeCloseTo(29.97, 2);
  });
  it("blackdetect", () => {
    expect(parseBlackdetect("[blackdetect @ 0x1] black_start:0 black_end:2.5 black_duration:2.5\nx")).toEqual([{ start: 0, end: 2.5, duration: 2.5 }]);
  });
  it("freezedetect closes an open freeze at end of file", () => {
    const t = "lavfi.freezedetect.freeze_start: 1\nlavfi.freezedetect.freeze_duration: 2\nlavfi.freezedetect.freeze_end: 3\nlavfi.freezedetect.freeze_start: 8";
    expect(parseFreezedetect(t, 10)).toEqual([{ start: 1, end: 3, duration: 2 }, { start: 8, end: 10, duration: 2 }]);
  });
  it("loudness summary and silence", () => {
    const t = "t: 1 I: -5.0 LUFS\n[Parsed_ebur128] Summary:\n\n  Integrated loudness:\n    I:         -16.3 LUFS\n  True peak:\n    Peak:       -2.1 dBFS\n mean_volume: -19.4 dB";
    expect(parseLoudness(t)).toEqual({ lufs: -16.3, truePeakDb: -2.1, meanDb: -19.4 });
    expect(parseLoudness("Summary:\n I: -inf LUFS\n mean_volume: -inf dB")).toMatchObject({ lufs: -91, meanDb: -91 });
  });
});

describe("qaFindings", () => {
  it("clean video: one info", () => expect(qaFindings(good)).toEqual([{ id: "all_clear", severity: "info", text: expect.any(String) }]));
  it("container blocks", () => {
    const v = good.facts.video!;
    expect(ids({ ...good, facts: { ...good.facts, video: { ...v, codec: "hevc" } } }, "block")).toEqual(["video_codec"]);
    expect(ids({ ...good, facts: { ...good.facts, video: { ...v, width: 720, height: 1280 } } }, "block")).toEqual(["size"]);
    expect(ids({ ...good, facts: { ...good.facts, audioCodec: null } }, "block")).toEqual(["audio_present"]);
    expect(ids({ ...good, facts: { ...good.facts, audioCodec: "mp3" } }, "block")).toEqual(["audio_codec"]);
    expect(ids({ ...good, facts: { ...good.facts, durationS: 181 }, narrationS: null }, "block")).toEqual(["duration"]);
    expect(ids({ ...good, facts: { ...good.facts, sizeBytes: FINDING_DEFAULTS.maxBytes + 1 } }, "block")).toEqual(["file_size"]);
    expect(ids({ ...good, facts: { ...good.facts, video: { ...v, fps: 24 } } }, "warn")).toEqual(["fps"]);
  });
  it("narration length: within 1 s is fine, more warns", () => {
    expect(ids({ ...good, narrationS: 30.9 })).toEqual(["all_clear"]);
    expect(ids({ ...good, narrationS: 33 }, "warn")).toEqual(["narration_length"]);
  });
  it("black first frame blocks, long black or freeze later warns, short runs pass", () => {
    expect(ids({ ...good, blackRuns: [{ start: 0, end: 0.2, duration: 0.2 }] }, "block")).toEqual(["first_frame_black"]);
    expect(ids({ ...good, blackRuns: [{ start: 5, end: 8, duration: 3 }], freezeRuns: [{ start: 10, end: 14, duration: 4 }] }, "warn")).toEqual(["black_run", "frozen_run"]);
    expect(ids({ ...good, blackRuns: [{ start: 5, end: 6, duration: 1 }], freezeRuns: [{ start: 10, end: 11, duration: 1 }] })).toEqual(["all_clear"]);
  });
  it("audio: silent blocks, off-range loudness and hot peak warn", () => {
    expect(ids({ ...good, meanDb: -60, lufs: -70 }, "block")).toEqual(["silent"]);
    expect(ids({ ...good, lufs: -25 }, "warn")).toEqual(["loudness"]);
    expect(ids({ ...good, lufs: -8 }, "warn")).toEqual(["loudness"]);
    expect(ids({ ...good, truePeakDb: -0.2 }, "warn")).toEqual(["clipping"]);
  });
});
