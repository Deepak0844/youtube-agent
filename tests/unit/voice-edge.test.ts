// Fixtures are hand-written from the public edge-tts protocol notes: UNRECORDED (no live capture yet).
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EDGE_VOICES } from "@/server/core/edge-voices";
import { LANGS } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createEdgeVoice, type WebSocketLike } from "@/server/providers/voice/edge";

let dir: string;
beforeAll(() => { dir = realpathSync(mkdtempSync(path.join(tmpdir(), "edge-"))); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const logs: string[] = [];
const ctx = (): StageContext =>
  ({ claim: { stageRunId: "r" }, attemptDir: dir, signal: new AbortController().signal, log: (l: string) => logs.push(l) }) as unknown as StageContext;

const audioFrame = (bytes: number[]) => {
  const head = Buffer.from("X-RequestId:1\r\nPath:audio\r\nContent-Type:audio/mpeg\r\n");
  const h = Buffer.alloc(2);
  h.writeUInt16BE(head.length);
  const b = Buffer.concat([h, head, Buffer.from(bytes)]);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};
const meta = (offset: number, duration: number, text: string) =>
  `Path:audio.metadata\r\n\r\n${JSON.stringify({ Metadata: [{ Type: "WordBoundary", Data: { Offset: offset, Duration: duration, text: { Text: text } } }] })}`;
const TURN_END = "X-RequestId:1\r\nPath:turn.end\r\n\r\n{}";

/** Scripted socket: after the client sends the two messages, it plays `script` and records what was sent. */
function scripted(script: (s: WebSocketLike) => void) {
  const sent: string[] = [];
  let url = "";
  let headers: Record<string, string> | undefined;
  const connect = (u: string, h?: Record<string, string>) => {
    url = u;
    headers = h;
    const s: WebSocketLike = {
      onopen: null, onmessage: null, onerror: null, onclose: null,
      send: (d) => { sent.push(d); if (sent.length === 2) queueMicrotask(() => script(s)); },
      close: () => {},
    };
    queueMicrotask(() => s.onopen?.({}));
    return s;
  };
  return { connect, sent, get url() { return url; }, get headers() { return headers; } };
}
const say = (connect: ReturnType<typeof scripted>["connect"], text = "Hello world") =>
  createEdgeVoice({ connect, timeoutMs: 2000 }).synthesise(ctx(), { text, lang: "en", voice: EDGE_VOICES.en });

describe("edge voice", () => {
  it("word_boundary_events_become_word_times", async () => {
    const t = scripted((s) => {
      s.onmessage?.({ data: audioFrame([1, 2, 3]) });
      s.onmessage?.({ data: meta(5_000_000, 3_000_000, "Hello") });
      s.onmessage?.({ data: meta(10_000_000, 4_000_000, "world") });
      s.onmessage?.({ data: audioFrame([4, 5]) });
      s.onmessage?.({ data: TURN_END });
    });
    const r = await say(t.connect);
    expect(r.timingsKind).toBe("native");
    expect(r.wordTimings).toEqual([{ word: "Hello", startS: 0.5, endS: 0.8 }, { word: "world", startS: 1, endS: 1.4 }]);
    expect(r.priceMicroUsd).toBe(0);
    expect([...readFileSync(r.audioPath)]).toEqual([1, 2, 3, 4, 5]);
    expect(t.url.startsWith("wss://speech.platform.bing.com/")).toBe(true);
    expect(t.headers?.Origin).toMatch(/^chrome-extension:/);
    expect(createEdgeVoice({ connect: t.connect }).quote({ text: "x", lang: "en", voice: "v" })).toBe(0);
    expect(createEdgeVoice({ connect: t.connect }).capability.local).toBe(false);
  });

  it("ssml_escapes_text_with_angle_brackets_and_ampersands", async () => {
    const t = scripted((s) => s.onclose?.({}));
    await say(t.connect, `a <b> & "c" 'd'`).catch(() => {});
    const ssml = t.sent[1]!;
    expect(ssml).toContain("a &#60;b&#62; &#38; &#34;c&#34; &#39;d&#39;");
    expect(ssml).not.toContain("<b>");
  });

  it("closed_before_audio_is_known_failure_after_audio_is_unknown", async () => {
    await expect(say(scripted((s) => s.onclose?.({})).connect)).rejects.toBeInstanceOf(KnownFailure);
    const after = scripted((s) => { s.onmessage?.({ data: audioFrame([1]) }); s.onclose?.({}); });
    const err = await say(after.connect).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(KnownFailure);
  });

  it("all_six_languages_have_a_default_voice", () => {
    for (const l of LANGS) expect(EDGE_VOICES[l]).toMatch(new RegExp(`^${l}-[A-Z]{2}-\\w+Neural$`));
  });

  it("no_secret_or_token_in_logs", async () => {
    logs.length = 0;
    const t = scripted((s) => s.onclose?.({}));
    await say(t.connect).catch(() => {});
    const ok = scripted((s) => { s.onmessage?.({ data: audioFrame([1]) }); s.onmessage?.({ data: meta(0, 1, "Hello") }); s.onmessage?.({ data: TURN_END }); });
    await say(ok.connect);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) expect(l).not.toMatch(/6A5AA1D4|Sec-MS-GEC|wss:|TrustedClientToken/i);
  });
});
