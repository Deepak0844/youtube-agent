import { describe, expect, it } from "vitest";
import { EngineLimitError, isEnginePause, istTime, parseLimit } from "@/server/engine/limit";

// Claude Code's usage-limit messages (5-hour and weekly). The step pauses until the reset time, shown in IST.
// 2026-11-13 is a Friday; 12:00Z is 17:30 IST.
const NOW = new Date("2026-11-13T12:00:00Z");

describe("parseLimit", () => {
  it("reads the epoch form", () => {
    expect(parseLimit("Claude AI usage limit reached|1794600000", NOW)).toEqual({ limit: true, resumeAt: new Date(1794600000 * 1000) });
  });
  it("limit_with_reset_time_parses_to_ist (later today)", () => {
    expect(parseLimit("You've hit your limit · resets 8pm (Asia/Calcutta)", NOW)).toEqual({ limit: true, resumeAt: new Date("2026-11-13T14:30:00Z") });
  });
  it("a reset time already past today means tomorrow", () => {
    const late = new Date("2026-11-13T15:30:00Z"); // 21:00 IST
    expect(parseLimit("You've hit your limit · resets 8pm (Asia/Kolkata)", late)).toEqual({ limit: true, resumeAt: new Date("2026-11-14T14:30:00Z") });
  });
  it("weekly_limit_variant_parses (weekday and minutes)", () => {
    expect(parseLimit("You’ve reached your weekly limit · resets Fri 9:30am (Asia/Kolkata)", NOW)).toEqual({ limit: true, resumeAt: new Date("2026-11-20T04:00:00Z") });
  });
  it("another time zone is honoured; no zone means IST", () => {
    expect(parseLimit("You've hit your limit · resets 6am (America/Los_Angeles)", NOW)).toEqual({ limit: true, resumeAt: new Date("2026-11-13T14:00:00Z") }); // it is 4:00 AM there: later today
    expect(parseLimit("You've hit your limit · resets 11pm", NOW)).toEqual({ limit: true, resumeAt: new Date("2026-11-13T17:30:00Z") });
  });
  it("unknown_429_is_a_limit_without_time", () => {
    expect(parseLimit("API Error: 429 {\"type\":\"rate_limit_error\"}", NOW)).toEqual({ limit: true, resumeAt: null });
    expect(parseLimit("API Error: Rate limit reached", NOW)).toEqual({ limit: true, resumeAt: null });
  });
  it("ordinary text is not a limit, even when it mentions 429 or limits later on", () => {
    expect(parseLimit("Done. The video has 429 frames and respects the limit.", NOW)).toEqual({ limit: false, resumeAt: null });
    expect(parseLimit("", NOW)).toEqual({ limit: false, resumeAt: null });
  });
  it("a reset time that is nonsense or in the past is ignored", () => {
    expect(parseLimit("Claude AI usage limit reached|1000", NOW)).toEqual({ limit: true, resumeAt: null });
    expect(parseLimit("You've hit your limit · resets 25pm", NOW)).toEqual({ limit: true, resumeAt: null });
  });
});

describe("istTime", () => {
  it("shows the time in IST", () => {
    expect(istTime(new Date("2026-11-13T14:30:00Z"), NOW)).toBe("8:00 PM"); // same IST day: time only
    expect(istTime(new Date("2026-11-20T04:00:00Z"), NOW)).toBe("Fri 9:30 AM"); // another day: weekday too
  });
});

describe("isEnginePause", () => {
  it("is true only for the limit note", () => {
    const note = new EngineLimitError(new Date("2026-11-13T14:30:00Z"), NOW).message;
    expect(isEnginePause({ error: `known_failure: ${note}` })).toBe(true);
    expect(isEnginePause({ error: "known_failure: The run was cancelled." })).toBe(false);
    expect(isEnginePause(null)).toBe(false);
  });
});
