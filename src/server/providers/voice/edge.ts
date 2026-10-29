import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LANGS } from "@/server/core/lang";
import { KnownFailure } from "@/server/core/paid-call";
import { StageAbort, type StageContext } from "@/server/core/stage-handler";
import type { VoiceProvider, WordTiming } from "./index";

// Microsoft Edge "read aloud" WebSocket. UNOFFICIAL and undocumented: it can change or stop without notice (ADR 0010).
// Protocol as used by the open-source edge-tts / edge-tts-universal projects. Free: no key, no price.
const HOST = "speech.platform.bing.com";
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4"; // public client token baked into Edge itself, not a secret
const CHROMIUM = "143.0.3650.75";
const URL_BASE = `wss://${HOST}/consumer/speech/synthesize/readaloud/edge/v1`;
const HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM.split(".")[0]}.0.0.0`,
};
const TICKS_PER_S = 10_000_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const NOT_AVAILABLE = "Edge voice is not available right now";

/** The slice of WebSocket this adapter uses (Node's global WebSocket fits). */
export interface WebSocketLike {
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Real socket: Node's built-in WebSocket accepts a `headers` option (Origin and User-Agent are required here). */
export const connectEdge = (url: string, headers?: Record<string, string>): WebSocketLike =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as WebSocketLike;

const xmlEscape = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function secMsGec(now: Date): string {
  const secs = Math.floor(now.getTime() / 1000) + 11644473600; // Windows file-time epoch
  const ticks = (secs - (secs % 300)) * TICKS_PER_S; // 5-minute steps, in 100 ns ticks
  return createHash("sha256").update(`${ticks}${TOKEN}`, "ascii").digest("hex").toUpperCase();
}

function stamp(now: Date): string {
  const [wd, dd, mon, yy, time] = now.toUTCString().replace(",", "").split(" ");
  return `${wd} ${mon} ${dd} ${yy} ${time} GMT+0000 (Coordinated Universal Time)`;
}

export function createEdgeVoice(deps: {
  connect: (url: string, headers?: Record<string, string>) => WebSocketLike;
  now?: () => Date;
  timeoutMs?: number;
}): VoiceProvider {
  const now = deps.now ?? (() => new Date());
  return {
    // maxChars is kept small: the service takes about 4 KB of SSML per request and Indic text is 3 bytes a letter.
    capability: { id: "edge", wordTimings: "native", local: false, languages: [...LANGS], maxChars: 1000, formats: ["mp3"] },
    quote: () => 0,
    async synthesise(ctx: StageContext, a) {
      const t0 = now();
      const url = `${URL_BASE}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${secMsGec(t0)}&Sec-MS-GEC-Version=1-${CHROMIUM}&ConnectionId=${randomUUID().replaceAll("-", "")}`;
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${xmlEscape(a.voice)}'>${xmlEscape(a.text)}</voice></speak>`;
      const { chunks, words } = await new Promise<{ chunks: Buffer[]; words: WordTiming[] }>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const words: WordTiming[] = [];
        let bytes = 0;
        let done = false;
        let ws: WebSocketLike | undefined;
        const timer = setTimeout(() => finish(new Error("Edge voice timed out")), deps.timeoutMs ?? 60_000);
        const onAbort = () => finish(ctx.signal.reason instanceof Error ? ctx.signal.reason : new StageAbort("cancel"));
        // Before any audio byte the failure is a clear "not available" (nothing was produced); after, it is unknown.
        function finish(err?: Error) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          try { ws?.close(); } catch { /* already closed */ }
          if (!err) return resolve({ chunks, words });
          if (err instanceof StageAbort || ctx.signal.aborted) return reject(err);
          ctx.log(`edge voice failed after ${bytes} audio bytes`);
          reject(bytes === 0 ? new KnownFailure(NOT_AVAILABLE) : err);
        }
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        try {
          ws = deps.connect(url, HEADERS);
        } catch (e) {
          return finish(e instanceof Error ? e : new Error("connect failed"));
        }
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          try {
            const id = randomUUID().replaceAll("-", "");
            ws!.send(
              `X-Timestamp:${stamp(t0)}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
                `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`,
            );
            ws!.send(`X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${t0.toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
          } catch (e) {
            finish(e instanceof Error ? e : new Error("send failed"));
          }
        };
        ws.onerror = () => finish(new Error("Edge voice socket error"));
        ws.onclose = () => finish(new Error("Edge voice closed before the end of the turn"));
        ws.onmessage = ({ data }) => {
          try {
            if (typeof data === "string") {
              const [head = "", body = ""] = data.split("\r\n\r\n", 2);
              if (/Path:turn\.end/.test(head)) {
                if (bytes === 0) throw new Error("no audio received");
                if (words.length === 0) throw new Error("no word timings received");
                return finish();
              }
              if (!/Path:audio\.metadata/.test(head)) return;
              for (const m of (JSON.parse(body) as { Metadata?: { Type: string; Data: { Offset: number; Duration: number; text: { Text: string } } }[] }).Metadata ?? []) {
                if (m.Type !== "WordBoundary") continue;
                words.push({ word: m.Data.text.Text, startS: m.Data.Offset / TICKS_PER_S, endS: (m.Data.Offset + m.Data.Duration) / TICKS_PER_S });
              }
            } else if (data instanceof ArrayBuffer) {
              const buf = Buffer.from(data);
              const headLen = buf.readUInt16BE(0);
              if (!buf.subarray(2, 2 + headLen).toString("utf8").includes("Path:audio") || buf.length <= 2 + headLen) return;
              const audio = buf.subarray(2 + headLen);
              bytes += audio.length;
              if (bytes > MAX_AUDIO_BYTES) throw new Error("Edge audio over the 50 MB cap");
              chunks.push(audio);
            }
          } catch (e) {
            finish(e instanceof Error ? e : new Error("bad Edge message"));
          }
        };
      });
      const audioPath = path.join(ctx.attemptDir, `voice-${createHash("sha256").update(`${a.lang}\0${a.voice}\0${a.text}`).digest("hex").slice(0, 12)}.mp3`);
      await writeFile(audioPath, Buffer.concat(chunks));
      ctx.log(`edge voice: ${words.length} words, ${chunks.reduce((n, c) => n + c.length, 0)} bytes`);
      return { audioPath, wordTimings: words, timingsKind: "native", priceMicroUsd: 0, quoted: true };
    },
  };
}
