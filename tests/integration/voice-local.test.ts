// Local voice servers against local fake HTTP servers (no network). Fixtures are hand-written from public docs: unrecorded.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotProcessedError } from "@/server/core/error-class";
import type { StageContext } from "@/server/core/stage-handler";
import { createCustomHttpVoice } from "@/server/providers/voice/custom-http";
import { createOpenAiCompatibleVoice } from "@/server/providers/voice/openai-compatible";
import { assertVoiceStudioUrl, createVoiceStudioVoice } from "@/server/providers/voice/voicestudio";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
const seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => undefined;
let server: Server;
let base: string;
let dir: string;
const logs: string[] = [];
const KEY = "sk-test-SECRET-key-12345";

function wav(seconds: number, rate = 1000): Buffer {
  const n = Math.round(seconds * rate);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

function ctx(): StageContext {
  return {
    attemptDir: dir,
    signal: new AbortController().signal,
    log: (l: string) => logs.push(l),
    claim: { stageRunId: "sr-1" },
    paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call("k", new AbortController().signal)).result,
  } as unknown as StageContext;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "voice-local-"));
  server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("latin1");
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const listed = () => [new URL(base).host];
const files = async () => (await readdir(dir)).sort();
const cleanDir = async () => { for (const f of await readdir(dir)) await rm(path.join(dir, f), { force: true }); seen.length = 0; logs.length = 0; };
const ok = (res: ServerResponse, buf: Buffer, type = "audio/wav") => { res.writeHead(200, { "content-type": type }); res.end(buf); };

describe("openai-compatible", () => {
  it("posts to /v1/audio/speech, saves wav, key only as Authorization Bearer and never logged", async () => {
    await cleanDir();
    handler = (_q, res) => ok(res, wav(0.5));
    const v = createOpenAiCompatibleVoice({ baseUrl: base, localServices: listed(), model: "m", voice: "alloy", getKey: async () => KEY, wordTimings: "aligned" });
    const r = await v.synthesise(ctx(), { text: "Hello there", lang: "en", voice: "alloy" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("/v1/audio/speech");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ model: "m", voice: "alloy", input: "Hello there", response_format: "wav" });
    expect(seen[0]!.url).not.toContain(KEY);
    expect(JSON.stringify([r, logs])).not.toContain(KEY);
    expect(r).toMatchObject({ timingsKind: "aligned", wordTimings: null, priceMicroUsd: 0 });
    expect(await files()).toEqual([path.basename(r.audioPath)]);
  });
  it("a failing call never puts the key in the error", async () => {
    handler = (_q, res) => { res.writeHead(401); res.end(`bad key ${KEY}`); };
    const v = createOpenAiCompatibleVoice({ baseUrl: base, localServices: listed(), model: "m", voice: "a", getKey: async () => KEY, wordTimings: "aligned" });
    const e = await v.synthesise(ctx(), { text: "x", lang: "en", voice: "a" }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(String((e as Error).message)).not.toContain(KEY);
  });
  it("refuses a local address that is not on the allow-list", async () => {
    const v = createOpenAiCompatibleVoice({ baseUrl: base, localServices: [], model: "m", voice: "a", wordTimings: "aligned" });
    await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "a" })).rejects.toBeInstanceOf(NotProcessedError);
  });
  it("redirect_to_lan_or_169.254_refused", async () => {
    for (const to of ["http://169.254.169.254/latest", `${base}/other`, "http://192.168.1.1/x"]) {
      seen.length = 0;
      handler = (q, res) => { if (q.url === "/other") ok(res, wav(0.1)); else { res.writeHead(302, { location: to }); res.end(); } };
      const v = createOpenAiCompatibleVoice({ baseUrl: base, localServices: listed(), model: "m", voice: "a", getKey: async () => KEY, wordTimings: "aligned" });
      await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "a" })).rejects.toBeInstanceOf(NotProcessedError);
      expect(seen.map((s) => s.url)).toEqual(["/v1/audio/speech"]);
    }
  });
  it("quote_is_zero_and_price_recorded_as_free", async () => {
    const v = createOpenAiCompatibleVoice({ baseUrl: base, localServices: listed(), model: "m", voice: "a", wordTimings: "estimated" });
    expect(v.quote({ text: "x".repeat(5000), lang: "en", voice: "a" })).toBe(0);
    expect(v.capability).toMatchObject({ local: true, wordTimings: "estimated" });
  });
});

describe("voicestudio", () => {
  it("voicestudio_non_loopback_without_key_refused_with_plain_message", () => {
    for (const u of ["http://192.168.1.5:3900", "http://10.0.0.2:3900", "https://voice.example.com", "http://[::ffff:7f00:1]:3900", "http://localhost.evil.com:3900"])
      expect(() => assertVoiceStudioUrl(u, false), u).toThrow(/key/i);
    for (const u of ["http://127.0.0.1:3900", "http://localhost:3900", "http://[::1]:3900", "http://127.5.5.5:1"]) expect(() => assertVoiceStudioUrl(u, false)).not.toThrow();
    expect(() => assertVoiceStudioUrl("https://192.168.1.5:3900", true)).not.toThrow();
    expect(() => assertVoiceStudioUrl("http://192.168.1.5:3900", true)).toThrow(/https/);
    expect(() => assertVoiceStudioUrl("http://127.0.0.1:3900", true)).not.toThrow();
    for (const u of ["http://user:pw@127.0.0.1:3900", "https://user@voice.example.com"]) {
      const e = (() => { try { assertVoiceStudioUrl(u, true); } catch (x) { return x as Error; } })();
      expect(e?.message, u).toBeTruthy();
      expect(e!.message).not.toContain("pw");
      expect(e!.message).not.toContain("voice.example");
    }
    expect(() => assertVoiceStudioUrl("ftp://127.0.0.1", true)).toThrow();
  });
  it("refuses a non-loopback url without a key before any request", async () => {
    const v = createVoiceStudioVoice({ baseUrl: "http://192.168.1.5:3900", localServices: ["192.168.1.5:3900"], voice: "v" });
    seen.length = 0;
    await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toThrow(/key/i);
    expect(seen).toHaveLength(0);
  });
  it("chunks_use_same_voice_seed_speed and times words with the same server", async () => {
    await cleanDir();
    const sentence = "The quick brown fox jumps over the lazy dog. ";
    const text = sentence.repeat(Math.ceil(7000 / sentence.length)).trim();
    let last = "";
    handler = (q, res, body) => {
      if (q.url === "/v1/audio/speech") { last = (JSON.parse(body) as { input: string }).input; return ok(res, wav(2)); }
      const ws = last.split(/\s+/).filter(Boolean);
      const chunkWords = ws.map((w, i) => ({ word: w, start: (i * 1.9) / ws.length, end: ((i + 1) * 1.9) / ws.length }));
      expect(body).toContain("timestamp_granularities[]");
      expect(body).toContain("verbose_json");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "x", words: chunkWords }));
    };
    const v = createVoiceStudioVoice({ baseUrl: base, localServices: listed(), voice: "v", speed: 1.1, seed: 42, getKey: async () => KEY });
    const r = await v.synthesise(ctx(), { text, lang: "en", voice: "v" });
    const speech = seen.filter((s) => s.url === "/v1/audio/speech").map((s) => JSON.parse(s.body) as Record<string, unknown>);
    expect(speech.length).toBeGreaterThanOrEqual(2);
    for (const b of speech) {
      expect((b.input as string).length).toBeLessThanOrEqual(3500);
      expect(b).toMatchObject({ voice: "v", seed: 42, speed: 1.1, response_format: "wav" });
    }
    expect(speech.map((b) => b.input).join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(seen.filter((s) => s.url === "/v1/audio/transcriptions").length).toBe(speech.length);
    for (const s of seen) expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r.timingsKind).toBe("aligned");
    expect(r.priceMicroUsd).toBe(0);
    expect(r.wordTimings!.length).toBe(text.split(/\s+/).length);
    const ts = r.wordTimings!;
    expect(ts.every((w, i) => i === 0 || w.startS >= ts[i - 1]!.startS)).toBe(true);
    expect(ts.at(-1)!.endS).toBeLessThanOrEqual(speech.length * 2 + 1e-6);
    expect(ts.at(-1)!.endS).toBeGreaterThan(2); // the second chunk is offset by the first chunk's length
    expect(await files()).toEqual([path.basename(r.audioPath)]); // chunk files removed
  });
});

describe("voicestudio word matching", () => {
  it("a chunk recognising only some words is never clean aligned", async () => {
    await cleanDir();
    handler = (q, res) => {
      if (q.url === "/v1/audio/speech") return ok(res, wav(2));
      res.writeHead(200); res.end(JSON.stringify({ words: [{ word: "The", start: 0, end: 0.3 }] }));
    };
    const v = createVoiceStudioVoice({ baseUrl: base, localServices: listed(), voice: "v" });
    const r = await v.synthesise(ctx(), { text: "The quick brown fox jumps over the lazy dog.", lang: "en", voice: "v" });
    expect(r.timingsKind).toBe("estimated");
    expect(r.wordTimings!.some((w) => w.flags?.includes("interpolated"))).toBe(true);
  });
  it("userinfo in the url is refused without echoing it", async () => {
    const v = createVoiceStudioVoice({ baseUrl: `http://u:SECRETPW@127.0.0.1:${new URL(base).port}`, localServices: listed(), voice: "v" });
    const e = await v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" }).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).not.toContain("SECRETPW");
  });
});

describe("custom http", () => {
  const base0 = { localServices: [] as string[], bodyTemplate: '{"input":"{text}","voice":"{voice}","lang":"{lang}"}', wordTimings: "estimated" as const };
  it("sends the key in the configured header and the filled body as one JSON string", async () => {
    await cleanDir();
    handler = (_q, res) => ok(res, wav(0.2));
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), headerName: "X-Api-Key", getKey: async () => KEY, responseKind: "audio" });
    const r = await v.synthesise(ctx(), { text: '"}, "x": "1', lang: "hi", voice: "vv" });
    expect(seen[0]!.headers["x-api-key"]).toBe(KEY);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body)).toEqual({ input: '"}, "x": "1', voice: "vv", lang: "hi" });
    expect(r.timingsKind).toBe("estimated");
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });
  it("refuses a bad header name or a key with control characters", async () => {
    for (const cfg of [{ headerName: "X\r\nEvil" }, { getKey: async () => "a\r\nb" }]) {
      const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "audio", getKey: async () => KEY, ...cfg });
      await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toBeInstanceOf(NotProcessedError);
    }
  });
  it("audio_over_cap_aborted_and_file_removed", async () => {
    await cleanDir();
    handler = (_q, res) => {
      res.writeHead(200, { "content-type": "audio/wav" }); // no content-length: the cap must hold while streaming
      const chunk = Buffer.alloc(1024 * 1024, 1);
      let sent = 0;
      const pump = () => { while (sent < 60) { sent++; if (!res.write(chunk)) return void res.once("drain", pump); } res.end(); };
      pump();
    };
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "audio" });
    await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toThrow(/50 MB/);
    expect(await files()).toEqual([]);
  });
  it("json_url fetches the audio, without the key", async () => {
    await cleanDir();
    handler = (q, res) => {
      if (q.url === "/tts") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { files: [{ href: `${base}/a.wav` }] } })); } else ok(res, wav(0.2));
    };
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), getKey: async () => KEY, responseKind: "json_url", urlJsonPath: "data.files[0].href" });
    const r = await v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" });
    expect(seen.map((s) => s.url)).toEqual(["/tts", "/a.wav"]);
    expect(seen[1]!.headers.authorization).toBeUndefined();
    expect(await files()).toEqual([path.basename(r.audioPath)]);
  });
  it("json_url_pointing_to_private_host_refused", async () => {
    for (const href of ["http://10.1.2.3/a.wav", "http://169.254.169.254/a.wav", "http://[::1]:1/a.wav", "file:///etc/passwd", "http://127.0.0.1:9/a.wav"]) {
      await cleanDir();
      handler = (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ url: href })); };
      const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "json_url" });
      await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" }), href).rejects.toThrow();
      expect(await files()).toEqual([]);
    }
  });
  it("json_url naming ANOTHER listed local service or a public http host is refused", async () => {
    const other = createServer((_q, res) => { res.writeHead(200); res.end("secret"); });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    let hits = 0;
    other.on("request", () => hits++);
    const otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/a.wav`;
    try {
      for (const href of [otherUrl, "http://example.com/a.wav", "https://10.0.0.5/a.wav"]) {
        await cleanDir();
        handler = (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ url: href })); };
        const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: [...listed(), new URL(otherUrl).host], responseKind: "json_url" });
        await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" }), href).rejects.toBeInstanceOf(NotProcessedError);
        expect(await files()).toEqual([]);
      }
      expect(hits).toBe(0);
    } finally { other.close(); }
  });
  it("refuses forbidden header names and a voice list on another origin", async () => {
    for (const headerName of ["Host", "content-type", "Content-Length", "Transfer-Encoding", "CONNECTION"]) {
      const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "audio", headerName, getKey: async () => KEY });
      await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" }), headerName).rejects.toBeInstanceOf(NotProcessedError);
    }
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "audio", listVoicesUrl: "https://example.com/voices", getKey: async () => KEY });
    await expect(v.listVoices!()).rejects.toBeInstanceOf(NotProcessedError);
    const u = createCustomHttpVoice({ ...base0, url: `http://a:b@127.0.0.1:${new URL(base).port}/tts`, localServices: listed(), responseKind: "audio" });
    await expect(u.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toBeInstanceOf(NotProcessedError);
  });
  it("json_url that redirects is refused", async () => {
    handler = (q, res) => {
      if (q.url === "/tts") { res.writeHead(200); res.end(JSON.stringify({ url: `${base}/r` })); } else { res.writeHead(302, { location: "http://169.254.169.254/" }); res.end(); }
    };
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "json_url" });
    await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toBeInstanceOf(NotProcessedError);
  });
  it("a bad template fails before any request", async () => {
    seen.length = 0;
    const v = createCustomHttpVoice({ ...base0, bodyTemplate: '{"{text}":1}', url: `${base}/tts`, localServices: listed(), responseKind: "audio" });
    await expect(v.synthesise(ctx(), { text: "x", lang: "en", voice: "v" })).rejects.toThrow(/key/);
    expect(seen).toHaveLength(0);
  });
  it("lists voices", async () => {
    handler = (_q, res) => { res.writeHead(200); res.end(JSON.stringify({ voices: ["a", { id: "b" }] })); };
    const v = createCustomHttpVoice({ ...base0, url: `${base}/tts`, localServices: listed(), responseKind: "audio", listVoicesUrl: `${base}/voices` });
    expect(await v.listVoices!()).toEqual(["a", "b"]);
  });
});
