import { describe, expect, it } from "vitest";
import { makeHostedFetch, whisperAligner } from "@/worker/stages/voice-for";

describe("voice-for wiring", () => {
  it("whisperAligner is off without WHISPER_MODEL and on with it", () => {
    expect(whisperAligner(async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }), ({} as NodeJS.ProcessEnv))).toBeUndefined();
    expect(typeof whisperAligner(async () => ({ code: 0, signal: null, truncated: false, timedOut: false, aborted: false }), { WHISPER_MODEL: "/m.bin" } as unknown as NodeJS.ProcessEnv)).toBe("function");
  });
  it("hostedFetch forwards the per-call options into safeFetch (no redirects, 120 s)", async () => {
    let seen: unknown;
    const f = makeHostedFetch((async (_u: string, _i: unknown, o: unknown) => { seen = o; return new Response("x"); }) as never);
    await f("https://api.elevenlabs.io/x", {}, { timeoutMs: 120_000, maxRedirects: 0 });
    expect(seen).toMatchObject({ mode: "typed", localServices: [], timeoutMs: 120_000, maxRedirects: 0 });
  });
});
