import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyError, NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import music402 from "../fixtures/sound/elevenlabs-402-music.json";
import rate429 from "../fixtures/sound/elevenlabs-429.json";
import sfxMeta from "../fixtures/sound/elevenlabs-sfx.meta.json";
import { createElevenLabsSound, GENERATED_LICENCE, type ElevenLabsSoundDeps } from "@/server/providers/sound/elevenlabs";

// The MP3 is a hand-written ID3 stub; the error bodies and the audio content type are recorded (2026-10-30, free tier), enough for the adapter's MP3 check. All HTTP goes to a local fake server.
const MP3 = Buffer.concat([Buffer.from("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000"), Buffer.alloc(64, 1)]);
const KEY = "sk_test_SECRETKEY0123456789abcdef";
let server: Server;
let base = "";
let dir = "";
let reqs: { url: string; key: string | undefined; body: Record<string, unknown> }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "snd-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      reqs.push({ url: req.url!, key: req.headers["xi-api-key"] as string | undefined, body: JSON.parse(raw || "{}") });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  reqs = [];
  handler = (_q, res) => res.writeHead(sfxMeta.status, { "content-type": sfxMeta.contentType }).end(MP3);
});

const ctx = () =>
  ({ attemptDir: dir, signal: new AbortController().signal, paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call("k", new AbortController().signal)).result }) as unknown as StageContext;
const sound = (over: Partial<ElevenLabsSoundDeps> = {}) =>
  createElevenLabsSound({
    fetch: (url, init) => fetch(url.replace("https://api.elevenlabs.io", base), init),
    getKey: async () => KEY,
    sfxPrice: { unit: "per_second", microUsd: 2000 },
    musicPrice: { unit: "per_second", microUsd: 2500 },
    budgetScopes: ["global"],
    ...over,
  });
const a = { prompt: "soft whoosh", seconds: 2 };

describe("elevenlabs sound", () => {
  it("sfx_is_one_request_with_quoted_price_and_licence", async () => {
    const r = await sound().makeSfx(ctx(), a);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ url: "/v1/sound-generation?output_format=mp3_44100_128", key: KEY, body: { text: "soft whoosh", duration_seconds: 2, model_id: "eleven_text_to_sound_v2" } });
    expect(r.provenance).toMatchObject({ provider: "elevenlabs_sfx", priceMicroUsd: 8000, quoted: true, licence: GENERATED_LICENCE });
    expect(r.bytes).toBe(MP3.length);
  });
  it("sfx_spend_is_recorded_at_the_per_second_cost_not_a_minute", async () => {
    let settled: { reserveMicroUsd: number; actualMicroUsd?: number } | undefined;
    const c = { attemptDir: dir, signal: new AbortController().signal, paid: async (s: { reserveMicroUsd: number }, call: (k: string, sg: AbortSignal) => Promise<{ result: unknown; actualMicroUsd: number }>) => { const o = await call("k", new AbortController().signal); settled = { reserveMicroUsd: s.reserveMicroUsd, actualMicroUsd: o.actualMicroUsd }; return o.result; } } as unknown as StageContext;
    await sound().makeSfx(c, { prompt: "x", seconds: 0.5 });
    expect(settled).toEqual({ reserveMicroUsd: 2000, actualMicroUsd: 2000 });
  });
  it("sfx_duration_0_and_31_make_no_request_and_no_reserve", async () => {
    let reserved = 0;
    const c = { attemptDir: dir, signal: new AbortController().signal, paid: async () => { reserved++; } } as unknown as StageContext;
    for (const seconds of [0, 31]) {
      await expect(sound().makeSfx(c, { prompt: "x", seconds })).rejects.toBeInstanceOf(KnownFailure);
      expect(() => sound().quoteSfx({ prompt: "x", seconds })).toThrow(KnownFailure);
    }
    expect(reserved).toBe(0);
    expect(reqs).toHaveLength(0);
  });
  it("music_is_one_synchronous_instrumental_request", async () => {
    const r = await sound().makeMusic(ctx(), { prompt: "calm pad", seconds: 60 });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ url: "/v1/music?output_format=mp3_44100_128", body: { prompt: "calm pad", music_length_ms: 60000, force_instrumental: true } });
    expect(r.provenance.priceMicroUsd).toBe(150000);
  });
  it("sfx_is_quoted_per_second_and_music_in_whole_minutes", () => {
    const p = sound();
    // Worst documented rate: 40 credits/s at an assumed $0.0001 a credit = 4000 micro-USD/s.
    expect(p.quoteSfx({ prompt: "x", seconds: 0.5 })).toBe(2000);
    expect(p.quoteSfx({ prompt: "x", seconds: 2 })).toBe(8000);
    expect(p.quoteSfx({ prompt: "x", seconds: 10 })).toBe(40000);
    expect(16 * p.quoteSfx({ prompt: "x", seconds: 10 })).toBe(640000);
    for (const s of [0.5, 2, 10, 30]) expect(p.quoteSfx({ prompt: "x", seconds: s })).toBeGreaterThanOrEqual(s * 40 * 100); // 40 credits/s x 100 micro-USD
    expect(p.quoteSfx({ prompt: "x", seconds: 10 })).toBeGreaterThanOrEqual(10 * 40 * 100);
    expect(p.quoteMusic({ prompt: "x", seconds: 61 })).toBe(2 * 150000);
  });
  it("prompt_is_cleaned_and_empty_or_over_500_refused_before_any_request", async () => {
    await sound().makeSfx(ctx(), { prompt: "  soft\u0000 whoosh\n ", seconds: 2 });
    expect(reqs[0]!.body.text).toBe("soft whoosh");
    for (const prompt of ["", " \u0007 ", "a".repeat(501)]) {
      await expect(sound().makeSfx(ctx(), { prompt, seconds: 2 })).rejects.toBeInstanceOf(KnownFailure);
      expect(() => sound().quoteSfx({ prompt, seconds: 2 })).toThrow(KnownFailure);
    }
    expect(reqs).toHaveLength(1);
  });
  it("unpriced_or_out_of_range_is_refused_before_any_request", async () => {
    await expect(sound({ sfxPrice: null }).makeSfx(ctx(), a)).rejects.toBeInstanceOf(KnownFailure);
    await expect(sound().makeSfx(ctx(), { ...a, seconds: 99 })).rejects.toBeInstanceOf(KnownFailure);
    await expect(sound().makeMusic(ctx(), { ...a, seconds: 1 })).rejects.toBeInstanceOf(KnownFailure);
    expect(reqs).toHaveLength(0);
  });
  it.each([400, 401, 403, 422])("status_%i_is_a_permanent_known_failure", async (s) => {
    handler = (_q, res) => res.writeHead(s).end("{}");
    const e = await sound().makeSfx(ctx(), a).catch((x) => x);
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(classifyError(e)).toBe("permanent");
    expect(reqs).toHaveLength(1);
  });
  it("429_is_transient", async () => {
    handler = (_q, res) => res.writeHead(429).end(JSON.stringify(rate429));
    const e = await sound().makeSfx(ctx(), a).catch((x) => x);
    expect(classifyError(e)).toBe("transient");
    expect(e.code).toBe("rate_limited");
  });
  it("music_plan_refusal_is_a_plain_known_failure", async () => {
    for (const s of [402, 403]) {
      handler = (_q, res) => res.writeHead(s).end(s === 402 ? JSON.stringify(music402) : "{}");
      const e = await sound().makeMusic(ctx(), { prompt: "x", seconds: 10 }).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
      expect(e.message).toBe("Music generation is not available on this ElevenLabs plan.");
    }
  });
  it.each([408, 500, 503])("status_%i_is_unknown_and_parks", async (s) => {
    handler = (_q, res) => res.writeHead(s).end("{}");
    const e = await sound().makeSfx(ctx(), a).catch((x) => x);
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e)).toBe("unknown");
  });
  it("socket_loss_after_send_and_bad_bodies_are_unknown", async () => {
    handler = (req) => req.socket.destroy();
    expect(await sound().makeSfx(ctx(), a).catch((x) => x)).not.toBeInstanceOf(KnownFailure);
    for (const body of [Buffer.alloc(0), Buffer.from("<html>not audio</html>")]) {
      handler = (_q, res) => res.writeHead(200).end(body);
      expect(await sound().makeMusic(ctx(), { prompt: "x", seconds: 10 }).catch((x) => x)).not.toBeInstanceOf(KnownFailure);
    }
    handler = (_q, res) => { res.writeHead(200, { "content-length": "1000" }); res.write(MP3); setTimeout(() => res.destroy(), 20); };
    expect(await sound().makeSfx(ctx(), a).catch((x) => x)).not.toBeInstanceOf(KnownFailure);
  });
  it("key_is_never_in_an_error_message", async () => {
    handler = (_q, res) => res.writeHead(500).end(KEY);
    const e = await sound().makeSfx(ctx(), a).catch((x) => x);
    expect(String(e.message)).not.toContain(KEY);
  });
});
