import { describe, expect, it } from "vitest";
import { KnownFailure } from "@/server/core/paid-call";
import { createCustomHttpVoice } from "@/server/providers/voice/custom-http";
import { createOpenAiCompatibleVoice } from "@/server/providers/voice/openai-compatible";
import { createVoiceStudioVoice } from "@/server/providers/voice/voicestudio";

const common = { localServices: [] as string[] };
const none = { budgetScopes: [] as string[] };

describe("free voice adapters without budget scopes", () => {
  it.each([
    ["voicestudio", () => createVoiceStudioVoice({ ...common, ...none, baseUrl: "http://127.0.0.1:1", voice: "v" })],
    ["openai-compatible", () => createOpenAiCompatibleVoice({ ...common, ...none, baseUrl: "http://127.0.0.1:1", model: "m", voice: "v", wordTimings: "estimated" })],
    ["custom-http", () => createCustomHttpVoice({ ...common, ...none, url: "http://127.0.0.1:1/tts", bodyTemplate: "{}", responseKind: "audio", wordTimings: "estimated" })],
  ])("%s fails fast with a plain KnownFailure, not a RangeError", (_n, build) => {
    let err: unknown;
    try { build(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(KnownFailure);
    expect(err).not.toBeInstanceOf(RangeError);
  });
});
