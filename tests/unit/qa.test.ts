import { describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { evaluateQa, type ProbeResult } from "@/server/core/qa";

const cfg = buildEngineConfig(new Map()).qa;
const good: ProbeResult = { width: 1080, height: 1920, durationS: 30, hasAudio: true, meanDb: -20, peakDb: -3, loopDiff: 2 };
const short: { expectAudio: boolean; format: "short" | "long" } = { expectAudio: true, format: "short" };
const failed = (p: ProbeResult, o = short) => evaluateQa(p, cfg, o).checks.filter((c) => !c.ok && c.level === "fail").map((c) => c.id);

describe("evaluateQa", () => {
  it("good video passes with every check ok", () => {
    const r = evaluateQa(good, cfg, short);
    expect(r.pass).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("wrong size and length fail", () => {
    expect(failed({ ...good, width: 720, height: 1280 })).toEqual(["size"]);
    expect(failed({ ...good, durationS: 5 })).toEqual(["duration"]);
    expect(failed({ ...good, durationS: 62 })).toEqual(["duration"]);
    expect(failed({ ...good, durationS: 61.4 })).toEqual([]); // inside tolerance
    expect(failed(good, { expectAudio: true, format: "long" })).toEqual(["size", "duration"]);
  });

  it("missing audio fails only when expected; quiet or clipped audio fails", () => {
    const silent = { ...good, hasAudio: false, meanDb: null, peakDb: null };
    expect(failed(silent)).toEqual(["audio_present"]);
    expect(failed(silent, { expectAudio: false, format: "short" })).toEqual([]);
    expect(failed({ ...good, meanDb: -55 })).toEqual(["loudness_floor"]);
    expect(failed({ ...good, peakDb: 0 })).toEqual(["peak_ceiling"]);
  });

  it("loop seam is only a warning", () => {
    const r = evaluateQa({ ...good, loopDiff: 100 }, cfg, short);
    expect(r.pass).toBe(true);
    expect(r.checks.find((c) => c.id === "loop_seam")).toMatchObject({ ok: false, level: "warn" });
  });

  it("is pure and deterministic", () => {
    const frozen = JSON.stringify(good);
    const a = evaluateQa(good, cfg, short);
    expect(evaluateQa(good, cfg, short)).toEqual(a);
    expect(JSON.stringify(good)).toBe(frozen);
  });
});
