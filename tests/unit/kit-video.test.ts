import { describe, expect, it } from "vitest";
import { buildVideoProps, parseVideoArgs } from "../../scripts/kit-video-lib";

const scenes = JSON.stringify({ version: 1, scenes: [{ id: "s1", beat: "b1", kind: "terminal", startMs: 0, durationMs: 2000, lines: [{ text: "ls" }] }] });

describe("parseVideoArgs", () => {
  it("takes a file and optional flags", () => {
    expect(parseVideoArgs(["--", "a.json", "--audio", "x.wav", "--captions", "c.json"])).toEqual({ file: "a.json", audio: "x.wav", captions: "c.json" });
    expect(parseVideoArgs(["a.json"])).toEqual({ file: "a.json" });
  });
  it("rejects bad usage", () => {
    for (const a of [[], ["a", "b"], ["a", "--audio"], ["a", "--nope"], ["--audio", "x.wav"]]) expect(parseVideoArgs(a)).toHaveProperty("error");
  });
});

describe("buildVideoProps", () => {
  it("returns props for a valid file", () => {
    const r = buildVideoProps(scenes, { fps: 30, audioSrc: "narration.wav", captionsText: JSON.stringify([{ word: "hi", startS: 0, endS: 0.4, estimated: true }]) });
    expect(r.ok && r.props.captions).toEqual([{ word: "hi", startS: 0, endS: 0.4, estimated: true }]);
    expect(r.ok && r.props.audioSrc).toBe("narration.wav");
  });
  it("reports scene errors and bad captions in plain text", () => {
    expect(buildVideoProps("{", { fps: 30 })).toHaveProperty("errors");
    expect(buildVideoProps(JSON.stringify({ version: 1, scenes: [] }), { fps: 30 }).ok).toBe(false);
    const bad = buildVideoProps(scenes, { fps: 30, captionsText: JSON.stringify([{ word: "hi", startS: 1, endS: 0 }]) });
    expect(!bad.ok && bad.errors[0]).toContain("word 1");
  });
});

describe("buildVideoProps for the render stage", () => {
  it("passes the staged asset map and reads stored caption words (source: estimated)", async () => {
    const { buildVideoProps: shared } = await import("@/shared/scene/video-props");
    const r = shared(scenes, { fps: 30, assets: { img1: "assets/img1.png" }, captionsText: JSON.stringify([{ word: "hi", startS: 0, endS: 0.4, source: "estimated", flags: [] }]) });
    expect(r.ok && r.props.assets).toEqual({ img1: "assets/img1.png" });
    expect(r.ok && r.props.captions).toEqual([{ word: "hi", startS: 0, endS: 0.4, estimated: true }]);
  });
});
