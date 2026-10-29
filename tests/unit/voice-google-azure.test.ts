import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { classifyError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import { LANGS } from "@/server/core/lang";
import type { StageContext } from "@/server/core/stage-handler";
import { ttsLocale } from "@/server/core/tts-locales";
import { createAzureVoice } from "@/server/providers/voice/azure";
import { createGoogleVoice } from "@/server/providers/voice/google";
import type { CloudVoiceDeps } from "@/server/providers/voice/cloud-tts";
import google from "../fixtures/voice/google-ok.json";
import azure from "../fixtures/voice/azure-ok.json";

// Fixtures are hand-written from public docs (unrecorded). All HTTP goes to a local fake server.
const KEY = "AIzaSECRETKEY0123456789abcdef";
let server: Server;
let base = "";
let dir = "";
let reqs: { url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const logs: string[] = [];
const mp3 = Buffer.from(azure.audioBase64, "base64");
const gOk = (_q: IncomingMessage, res: ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(google));
const aOk = (_q: IncomingMessage, res: ServerResponse) => res.writeHead(200, { "content-type": "audio/mpeg" }).end(mp3);

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "ga-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      reqs.push({ url: req.url!, headers: req.headers, body: raw });
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
});

const ctx = (): StageContext =>
  ({
    attemptDir: dir,
    signal: new AbortController().signal,
    log: (l: string) => logs.push(l),
    paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call("k", new AbortController().signal)).result,
  }) as unknown as StageContext;

const seen: string[] = [];
const deps = (over: Partial<CloudVoiceDeps> = {}): CloudVoiceDeps => ({
  fetch: (url, init) => (seen.push(url), fetch(base + new URL(url).pathname, init)),
  getKey: async () => KEY,
  price: { unit: "per_1k_chars", microUsd: 16000 },
  budgetScopes: ["global"],
  ...over,
});
const g = (over?: Partial<CloudVoiceDeps>) => createGoogleVoice(deps(over));
const az = (over?: Partial<CloudVoiceDeps>, region = "eastus") => createAzureVoice({ ...deps(over), region });
const GV = "en-US-Neural2-A";
const AV = "en-US-JennyNeural";
const ga = (text: string) => ({ text, lang: "en" as const, voice: GV });
const aa = (text: string) => ({ text, lang: "en" as const, voice: AV });

const cases = [
  { name: "google", make: g, args: ga, ok: gOk },
  { name: "azure", make: az, args: aa, ok: aOk },
] as const;

describe("google voice", () => {
  it("one_request_with_key_in_header_only", async () => {
    handler = gOk;
    const r = await g().synthesise(ctx(), ga("Hi all"));
    expect(reqs).toHaveLength(1);
    expect(seen[0]).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(reqs[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(reqs[0]!.url).not.toContain(KEY);
    expect(JSON.parse(reqs[0]!.body)).toEqual({
      input: { ssml: "<speak>Hi all</speak>" },
      voice: { languageCode: "en-US", name: GV },
      audioConfig: { audioEncoding: "MP3" },
    });
    expect(r).toMatchObject({ wordTimings: null, timingsKind: "aligned", priceMicroUsd: 96, quoted: true });
    expect((await readFile(r.audioPath)).subarray(0, 3).toString()).toBe("ID3");
  });
});

describe("azure voice", () => {
  it("one_request_on_typed_regional_host_with_key_in_header_only", async () => {
    handler = aOk;
    const r = await az().synthesise(ctx(), aa("Hi all"));
    expect(seen.at(-1)).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(reqs[0]!.headers["ocp-apim-subscription-key"]).toBe(KEY);
    expect(reqs[0]!.headers["x-microsoft-outputformat"]).toBe("audio-24khz-96kbitrate-mono-mp3");
    expect(reqs[0]!.headers["content-type"]).toBe("application/ssml+xml");
    expect(reqs[0]!.body).toBe(`<speak version="1.0" xml:lang="en-US"><voice name="${AV}">Hi all</voice></speak>`);
    expect(r).toMatchObject({ wordTimings: null, timingsKind: "aligned", priceMicroUsd: 96 });
  });

  it("region_with_dots_or_slashes_rejected", async () => {
    handler = aOk;
    for (const region of ["a.b", "evil.com/x", "east us", "ab", "x".repeat(31), "EASTUS", "a@b.c", ""]) {
      const e = await az({}, region).synthesise(ctx(), aa("Hi")).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
    }
    expect(reqs).toHaveLength(0);
  });
});

describe.each(cases)("$name shared rules", ({ make, args, ok }) => {
  it("locale_map_covers_six_languages_or_throws_unsupported_language_with_plain_message", async () => {
    expect(LANGS.map((l) => ttsLocale(l))).toEqual(["en-US", "hi-IN", "ta-IN", "te-IN", "ml-IN", "kn-IN"]);
    handler = ok;
    const e = await make().synthesise(ctx(), { ...args("Hi"), lang: "fr" as never }).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toMatch(/do not support this language/);
    expect(reqs).toHaveLength(0);
    const hi = await make().synthesise(ctx(), { text: "नमस्ते", lang: "hi", voice: args("x").voice.replace("en-US", "hi-IN") });
    expect(hi.audioPath).toBeTruthy();
  });

  it("unpriced_or_unknown_voice_refused_before_any_call", async () => {
    handler = ok;
    for (const p of [null, { unit: "per_second", microUsd: 5 } as const]) {
      const e = await make({ price: p }).synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
      expect(() => make({ price: p }).quote(args("Hi"))).toThrow(KnownFailure);
    }
    for (const voice of ["", "bad voice", "hi-IN-Foo", "en-US-../x", "en-US-<x>"]) {
      const e = await make().synthesise(ctx(), { ...args("Hi"), voice }).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
    }
    expect(reqs).toHaveLength(0);
  });

  it("too_long_in_bytes_is_refused_before_any_call_and_a_line_at_the_limit_passes", async () => {
    handler = ok;
    const hiVoice = args("x").voice.replace("en-US", "hi-IN");
    const hindi = "नमस्ते ".repeat(500); // 3,500 characters, about 10 KB in UTF-8
    expect(Array.from(hindi).length).toBeLessThanOrEqual(3500);
    const e = await make().synthesise(ctx(), { text: hindi, lang: "hi", voice: hiVoice }).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toBe("This line is too long for this voice; split it.");
    expect(() => make().quote({ text: hindi, lang: "hi", voice: hiVoice })).toThrow(KnownFailure);
    expect(reqs).toHaveLength(0);
    const edge = make().capability.id === "google_tts" ? 5000 - "<speak></speak>".length : 9000 - 100;
    await make().synthesise(ctx(), args("a".repeat(edge)));
    expect(reqs).toHaveLength(1);
    const cap = make().capability.maxChars;
    expect(cap * 3).toBeLessThan(make().capability.id === "google_tts" ? 5000 : 9000);
  });

  it("xml_illegal_control_characters_are_dropped", async () => {
    handler = ok;
    await make().synthesise(ctx(), args("a\u0000b\u0008c\u001fd\te\nf"));
    expect(reqs[0]!.body).toContain("abcd");
    expect(reqs[0]!.body).toMatch(/abcd(\t|\\t)e(\n|\\n)f/);
    expect(reqs[0]!.body).not.toMatch(/\\u00|[\u0000-\u0008\u001f]/);
  });

  it("ssml_is_escaped", async () => {
    handler = ok;
    await make().synthesise(ctx(), args(`a & b <break/> "q" 'r' </speak><x>`));
    expect(reqs[0]!.body).toContain("a &amp; b &lt;break/&gt; &quot;q&quot; &apos;r&apos; &lt;/speak&gt;&lt;x&gt;");
    expect(reqs[0]!.body).not.toContain("<break/>");
  });

  it("401_known_failure_5xx_transient_reset_after_send_unknown", async () => {
    for (const s of [400, 401, 403, 422]) {
      handler = (_q, res) => res.writeHead(s).end("no");
      const e = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("permanent");
    }
    handler = (_q, res) => res.writeHead(429).end("slow");
    const e429 = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(classifyError(e429)).toBe("transient");
    for (const s of [408, 500, 503]) {
      handler = (_q, res) => res.writeHead(s).end("x");
      const e = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).not.toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("unknown");
    }
    handler = (q) => q.socket.destroy();
    const reset = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(reset).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(reset)).toBe("unknown");
    handler = (_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("{");
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const cut = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(cut).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(cut)).toBe("unknown");
  });

  it("empty_or_non_audio_body_is_unknown", async () => {
    for (const body of ["", "<html>nope</html>", JSON.stringify({ audioContent: "" }), JSON.stringify({ audioContent: Buffer.from("RIFFxxxx").toString("base64") })]) {
      handler = (_q, res) => res.writeHead(200).end(body);
      const e = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(KnownFailure);
      expect(classifyError(e)).toBe("unknown");
    }
  });

  it("redirect_options_passed_and_response_over_50mb_is_unknown", async () => {
    let opts: unknown;
    handler = ok;
    await make({ fetch: (url, init, o) => ((opts = o), fetch(base + new URL(url).pathname, init)) }).synthesise(ctx(), args("Hi"));
    expect(opts).toEqual({ timeoutMs: 120_000, maxRedirects: 0 });
    handler = (_q, res) => res.writeHead(200, { "content-length": String(60 * 1024 * 1024) }).end("x");
    const e = await make().synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(e.message).toMatch(/50 MB/);
    expect(classifyError(e)).toBe("unknown");
  });

  it("key_not_in_url_or_logs", async () => {
    handler = (_q, res) => res.writeHead(500).end(`echo ${KEY}`);
    const e = await make({ fetch: (url, init) => fetch(base + new URL(url).pathname, init) }).synthesise(ctx(), args("Hi")).catch((x) => x);
    handler = ok;
    await make().synthesise(ctx(), args("Hi"));
    expect(String(e.message) + JSON.stringify(e) + logs.join()).not.toContain(KEY);
    for (const u of seen) expect(u).not.toContain(KEY);
    for (const r of reqs) expect(r.url).not.toContain(KEY);
  });

  it("missing_key_is_known_failure", async () => {
    handler = ok;
    const e = await make({ getKey: async () => "" }).synthesise(ctx(), args("Hi")).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect(reqs).toHaveLength(0);
  });
});
