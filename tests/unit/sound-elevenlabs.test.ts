import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyError, NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createElevenLabsSound, GENERATED_LICENCE, type ElevenLabsSoundDeps } from "@/server/providers/sound/elevenlabs";

// Fixture is hand-written (unrecorded): an ID3-tagged stub, enough for the adapter's MP3 check. All HTTP goes to a local fake server.
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
  handler = (_q, res) => res.writeHead(200, { "content-type": "audio/mpeg" }).end(MP3);
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
    expect(r.provenance).toMatchObject({ provider: "elevenlabs_sfx", priceMicroUsd: 4000, quoted: true, licence: GENERATED_LICENCE });
    expect(r.bytes).toBe(MP3.length);
  });
  it("music_is_one_synchronous_instrumental_request", async () => {
    const r = await sound().makeMusic(ctx(), { prompt: "calm pad", seconds: 60 });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ url: "/v1/music?output_format=mp3_44100_128", body: { prompt: "calm pad", music_length_ms: 60000, force_instrumental: true } });
    expect(r.provenance.priceMicroUsd).toBe(150000);
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
    handler = (_q, res) => res.writeHead(429).end("{}");
    expect(classifyError(await sound().makeSfx(ctx(), a).catch((x) => x))).toBe("transient");
  });
  it("music_plan_refusal_is_a_plain_known_failure", async () => {
    for (const s of [402, 403]) {
      handler = (_q, res) => res.writeHead(s).end("{}");
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
