import type { EngineConfig } from "./engine-config";

// Pure QA rules. The probe adapter (render/probe.ts) measures; this file only judges. No I/O, no clock.
export interface ProbeResult {
  width: number;
  height: number;
  durationS: number;
  hasAudio: boolean;
  meanDb: number | null; // null when there is no audio
  peakDb: number | null;
  loopDiff: number | null; // mean absolute difference of first and last frame, 0..255
}

export type QaConfig = EngineConfig["qa"];
export interface QaCheck {
  id: string;
  ok: boolean;
  level: "fail" | "warn";
  detail: string;
}

export function evaluateQa(
  p: ProbeResult,
  cfg: QaConfig,
  opts: { expectAudio: boolean; format: "short" | "long" },
): { pass: boolean; checks: QaCheck[] } {
  const t = cfg[opts.format];
  const checks: QaCheck[] = [];
  const add = (id: string, ok: boolean, level: "fail" | "warn", detail: string) => checks.push({ id, ok, level, detail });

  add("size", p.width === t.width && p.height === t.height, "fail", `size is ${p.width}x${p.height}, expected ${t.width}x${t.height}`);
  add(
    "duration",
    p.durationS >= t.minS - cfg.durationToleranceS && p.durationS <= t.maxS + cfg.durationToleranceS,
    "fail",
    `length is ${p.durationS.toFixed(1)}s, expected ${t.minS}-${t.maxS}s (tolerance ${cfg.durationToleranceS}s)`,
  );
  if (opts.expectAudio) {
    add("audio_present", p.hasAudio, "fail", p.hasAudio ? "audio track found" : "no audio track");
    if (p.hasAudio && p.meanDb !== null) add("loudness_floor", p.meanDb >= cfg.meanDbMin, "fail", `mean loudness ${p.meanDb} dB, floor ${cfg.meanDbMin} dB`);
    if (p.hasAudio && p.peakDb !== null) add("peak_ceiling", p.peakDb <= cfg.peakDbMax, "fail", `peak ${p.peakDb} dB, ceiling ${cfg.peakDbMax} dB`);
  }
  if (p.loopDiff !== null) {
    add("loop_seam", p.loopDiff <= cfg.loopDiffMax, "warn", `first and last frame differ by ${p.loopDiff.toFixed(1)} of 255, limit ${cfg.loopDiffMax}`);
  }
  return { pass: checks.every((c) => c.ok || c.level === "warn"), checks };
}
