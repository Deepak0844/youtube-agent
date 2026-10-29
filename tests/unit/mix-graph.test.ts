import { describe, expect, it } from "vitest";
import { audibilityCheck, buildMixGraph } from "@/server/core/mix-graph";
import type { SfxPlan } from "@/server/core/sfx-plan";

const A = { videoS: 10, voiceFile: "/v/voice.wav", videoFile: "/v/render.mp4", outFile: "/o/out.mp4", items: { x: "/a/x.wav", m: "/a/m.wav" }, qa: { meanDbMin: -40, peakDbMax: -0.3 } };
const plan = (p: Partial<SfxPlan>): SfxPlan => ({ version: 1, cues: [], ...p });
const cue = (id: string, atS: number) => ({ id, itemId: "x", atS, gainDb: -12, optional: false });
const graph = (args: string[]) => args[args.indexOf("-filter_complex") + 1];

describe("buildMixGraph", () => {
  it("cue_past_end_dropped_and_reported", () => {
    const r = buildMixGraph(plan({ cues: [cue("in", 2), cue("late", 10), cue("later", 11)] }), A);
    expect(r.droppedCues).toEqual(["late", "later"]);
    expect(graph(r.args)).toContain("adelay=2000");
    expect(graph(r.args)).not.toContain("adelay=10000");
  });
  it("overlapping_cues_both_mixed_and_limiter_ceiling_holds", () => {
    const g = graph(buildMixGraph(plan({ cues: [cue("a", 2), cue("b", 2.1)] }), A).args);
    expect(g).toContain("[c0]");
    expect(g).toContain("[c1]");
    expect(g).toContain("amix=inputs=2");
    expect(g).toMatch(/alimiter=limit=0\.8414/);
  });
  it("ducking_graph_contains_sidechain_only_when_bed_or_cues_exist", () => {
    expect(graph(buildMixGraph(plan({}), A).args)).not.toContain("sidechaincompress");
    expect(graph(buildMixGraph(plan({ cues: [cue("a", 1)] }), A).args)).toContain("sidechaincompress");
    expect(graph(buildMixGraph(plan({ bed: { item: "m", gainDb: -20, loop: true } }), A).args)).toContain("sidechaincompress");
  });
  it("zero_cues_passes_through_narration_unchanged_length", () => {
    const { args } = buildMixGraph(plan({}), A);
    expect(graph(args)).toBe("[1:a]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,alimiter=limit=0.8414:level=0[out]");
    expect(args.filter((x) => x === "-i")).toHaveLength(2);
  });
  it("forces safe args and keeps the video stream", () => {
    const { args } = buildMixGraph(plan({ cues: [cue("a", 1)] }), A);
    expect(args.slice(0, 2)).toEqual(["-nostdin", "-hide_banner"]);
    expect(args.filter((x) => x === "-protocol_whitelist")).toHaveLength(3);
    expect(args).toContain("copy");
    expect(args.at(-1)).toBe("/o/out.mp4");
  });
  it("drops a cue whose item is unknown", () => {
    expect(buildMixGraph(plan({ cues: [{ ...cue("a", 1), itemId: "nope" }] }), A).droppedCues).toEqual(["a"]);
  });
});

describe("audibilityCheck", () => {
  it("over speech the cue must lift the mix by about 1 dB", () => {
    const quiet = audibilityCheck({ id: "a" }, { cueRmsDb: -30, voiceRmsDbAtCue: -20 });
    expect(quiet.audible).toBe(false);
    expect(quiet.headroomDb).toBeCloseTo(0.41 - 1, 1);
    expect(audibilityCheck({ id: "a" }, { cueRmsDb: -14, voiceRmsDbAtCue: -20 }).audible).toBe(true);
    expect(audibilityCheck({ id: "a" }, { cueRmsDb: -24, voiceRmsDbAtCue: -20 }).audible).toBe(true);
  });
  it("in a gap not silent and 7 dB below dense narration", () => {
    expect(audibilityCheck({ id: "a" }, { cueRmsDb: -30, voiceRmsDbAtCue: -80 }).audible).toBe(true);
    expect(audibilityCheck({ id: "a" }, { cueRmsDb: -80, voiceRmsDbAtCue: -80 }).audible).toBe(false);
    expect(audibilityCheck({ id: "a" }, { cueRmsDb: -24, voiceRmsDbAtCue: -80 }).audible).toBe(false);
  });
});
