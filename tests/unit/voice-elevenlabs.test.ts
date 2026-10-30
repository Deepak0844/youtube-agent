import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createElevenLabsVoice } from "@/server/providers/voice/elevenlabs";
import type { ElevenLabsDeps } from "@/server/providers/voice/eleven-types";
import en from "../fixtures/voice/elevenlabs-en.json";
import hi from "../fixtures/voice/elevenlabs-hi.json";
import libraryVoice402 from "../fixtures/voice/elevenlabs-402-library-voice.json"; // recorded 2026-10-30, free tier

// Fixtures are hand-written from the public docs (unrecorded). All HTTP goes to a local fake server.
const KEY = "sk_test_SECRETKEY0123456789abcdef";
let server: Server;
let base = "";
let dir = "";
let reqs: { url: string; key: string | undefined; body: { text: string; model_id: string } }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const logs: string[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "el-"));
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
  logs.length = 0;
  handler = (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(en));
});

const ctx = (): StageContext =>
  ({
    attemptDir: dir,
    signal: new AbortController().signal,
    log: (l: string) => logs.push(l),
    paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call("k", new AbortController().signal)).result,
  }) as unknown as StageContext;

const voice = (over: Partial<ElevenLabsDeps> = {}) =>
  createElevenLabsVoice({
    fetch: (url, init) => fetch(url.replace("https://api.elevenlabs.io", base), init),
    getKey: async () => KEY,
    model: "eleven_multilingual_v2",
    voiceId: "voice1",
    price: { unit: "per_1k_chars", microUsd: 80000 },
    budgetScopes: ["global"],
    ...over,
  });
const args = (text: string) => ({ text, lang: "en" as const, voice: "voice1" });

describe("elevenlabs voice", () => {
  it("sends_exactly_one_request_per_line", async () => {
    const r = await voice().synthesise(ctx(), args("Hi all"));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.url).toBe("/v1/text-to-speech/voice1/with-timestamps?output_format=mp3_44100_128");
    expect(reqs[0]!.key).toBe(KEY);
    expect(reqs[0]!.body).toEqual({ text: "Hi all", model_id: "eleven_multilingual_v2" });
    expect(r.timingsKind).toBe("native");
    expect(r.priceMicroUsd).toBe(480);
    expect((await readFile(r.audioPath)).length).toBeGreaterThan(0);
  });

  it("maps_character_times_to_word_times_for_english_and_hindi", async () => {
    const e = await voice().synthesise(ctx(), args("Hi all"));
    expect(e.wordTimings).toEqual([
      { word: "Hi", startS: 0, endS: 0.2 },
      { word: "all", startS: 0.3, endS: 0.6 },
    ]);
    handler = (_q, res) => res.writeHead(200).end(JSON.stringify(hi));
    const h = await voice().synthesise(ctx(), { ...args("नमस्ते दोस्त"), lang: "hi" });
    expect(h.wordTimings?.map((w) => w.word)).toEqual(["नमस्ते", "दोस्त"]);
    expect(h.wordTimings![1]).toEqual({ word: "दोस्त", startS: 0.6, endS: 1.1 });
  });

  it("402_paid_plan_required_is_a_plain_library_voice_message_without_the_body", async () => {
    handler = (_q, res) => res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify(libraryVoice402));
    const e = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toBe("This voice is a library voice: free accounts cannot use it via the API. Use a voice from your own account.");
    expect(JSON.stringify(e)).not.toContain("Upgrade");
    expect(classifyError(e)).toBe("permanent");
  });

  it("429_is_known_failure_retry_and_socket_reset_after_send_is_unknown", async () => {
    handler = (_q, res) => res.writeHead(429).end("slow down");
    const e429 = await voice().synthesise(ctx(), args("Hi")).catch((e) => e);
    expect(e429).toBeInstanceOf(KnownFailure);
    expect(classifyError(e429)).toBe("transient");
    for (const s of [401, 403, 422]) {
      handler = (_q, res) => res.writeHead(s).end("no");
      const e = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("permanent");
    }
    handler = (_q, res) => res.writeHead(408).end("timeout");
    const e408 = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(e408).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e408)).toBe("unknown");
    handler = (_q, res) => res.writeHead(503).end("busy");
    const e5 = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(e5).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e5)).toBe("unknown");
    handler = (q) => q.socket.destroy();
    const reset = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(reset).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(reset)).toBe("unknown");
    // truncated body: promises more bytes than it sends
    handler = (_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("{");
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const cut = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(cut).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(cut)).toBe("unknown");
  });

  it("key_never_appears_in_logs_or_error_text", async () => {
    const seen: string[] = [];
    for (const h of [
      (_q: IncomingMessage, res: ServerResponse) => res.writeHead(401).end(`bad key ${KEY}`),
      (q: IncomingMessage) => q.socket.destroy(),
      (_q: IncomingMessage, res: ServerResponse) => res.writeHead(500).end(KEY),
    ]) {
      handler = h;
      const e = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
      seen.push(String(e), (e as Error).message, JSON.stringify(e, Object.getOwnPropertyNames(e)));
    }
    const noKey = await voice({ getKey: async () => { throw new Error(`vault says ${KEY}`); } }).synthesise(ctx(), args("Hi")).catch((x) => x);
    seen.push(String(noKey), JSON.stringify(noKey, Object.getOwnPropertyNames(noKey)));
    expect([...seen, ...logs].join("\n")).not.toContain(KEY);
  });

  it("delivery_tag_is_inserted_and_capped", async () => {
    const long = "[" + "x".repeat(200) + "]";
    await voice({ model: "eleven_v3", tags: { prefix: "[excited]\u0000\n" } }).synthesise(ctx(), args("Hi all"));
    expect(reqs[0]!.body.text).toBe("[excited] Hi all");
    await voice({ model: "eleven_v3", tags: { prefix: long } }).synthesise(ctx(), args("Hi all"));
    // the 80-code-point cut leaves an unclosed "[": it is dropped, so no tag is sent
    expect(reqs[1]!.body.text).toBe("Hi all");
    const near = "[" + "x".repeat(70) + "] [ab";
    await voice({ model: "eleven_v3", tags: { prefix: near } }).synthesise(ctx(), args("Hi"));
    expect(reqs[2]!.body.text).toBe("[" + "x".repeat(70) + "] Hi");
    await voice({ tags: { prefix: "[excited]" } }).synthesise(ctx(), args("Hi")); // v2: tag not sent
    expect(reqs[3]!.body.text).toBe("Hi");
    // tag words are dropped from the returned timings when the provider aligned them
    handler = (_q, res) =>
      res.writeHead(200).end(JSON.stringify({ audio_base64: "SUQzAAAAAAAA", alignment: { characters: [..."[a] Hi"], character_start_times_seconds: [0, 1, 2, 3, 4, 5], character_end_times_seconds: [1, 2, 3, 4, 5, 6] } }));
    const r = await voice({ model: "eleven_v3", tags: { prefix: "[a]" } }).synthesise(ctx(), args("Hi"));
    expect(r.wordTimings).toEqual([{ word: "Hi", startS: 4, endS: 6 }]);
  });

  it("unknown_model_or_unpriced_voice_refused_before_call", async () => {
    await expect(voice({ model: "eleven_flash_v2_5" }).synthesise(ctx(), args("Hi"))).rejects.toBeInstanceOf(KnownFailure);
    await expect(voice({ price: null }).synthesise(ctx(), args("Hi"))).rejects.toBeInstanceOf(KnownFailure);
    await expect(voice().synthesise(ctx(), { ...args("Hi"), voice: "../x" })).rejects.toBeInstanceOf(KnownFailure);
    await expect(voice().synthesise(ctx(), { ...args("Hi"), model: "nope" })).rejects.toBeInstanceOf(KnownFailure);
    expect(() => voice({ price: null }).quote(args("Hi"))).toThrow(KnownFailure);
    expect(reqs).toHaveLength(0);
  });

  it("quote_counts_code_points_not_bytes", () => {
    const v = voice();
    expect(v.quote(args("नमस्ते"))).toBe(480); // 6 code points (18 bytes) x 80 micro-USD
    expect(v.quote(args("😀😀"))).toBe(160); // 2 code points
    expect(voice({ model: "eleven_v3", tags: { prefix: "[a]" } }).quote(args("Hi"))).toBe(480); // "[a] Hi" = 6, tags included
  });

  it("response_over_50MB_is_refused", async () => {
    handler = (_q, res) => {
      res.writeHead(200);
      const chunk = Buffer.alloc(1024 * 1024, 65);
      for (let i = 0; i < 51; i++) res.write(chunk);
      res.end();
    };
    const e = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(String(e)).toMatch(/50 MB/);
    expect(classifyError(e)).toBe("unknown");
  });

  it("empty_or_non_mp3_audio_is_unknown", async () => {
    for (const audio of ["", "AAAA"]) {
      handler = (_q, res) => res.writeHead(200).end(JSON.stringify({ ...en, audio_base64: audio }));
      const e = await voice().synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).not.toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("unknown");
    }
  });

  it("redirect_is_unknown_and_languages_follow_the_model", async () => {
    handler = (_q, res) => res.writeHead(307, { location: "/elsewhere" }).end();
    let opts: unknown;
    const e = await voice({ fetch: (url, init, o) => ((opts = o), fetch(url.replace("https://api.elevenlabs.io", base), { ...init, redirect: "error" })) }).synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(opts).toEqual({ timeoutMs: 120_000, maxRedirects: 0 });
    expect(voice().capability.languages).toEqual(["en", "hi", "ta"]);
    expect(voice({ model: "eleven_v3" }).capability.languages).toEqual(["en", "hi", "ta", "te", "ml", "kn"]);
  });
});
