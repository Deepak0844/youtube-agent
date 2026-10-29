// Fixture is hand-written, UNRECORDED. Real filesystem, scripted socket, no network.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { StageContext } from "@/server/core/stage-handler";
import { createEdgeVoice, type WebSocketLike } from "@/server/providers/voice/edge";

it("edge voice lands an mp3 in the attempt dir with native word times", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "edge-int-")));
  try {
    const head = Buffer.from("Path:audio\r\n");
    const h = Buffer.alloc(2);
    h.writeUInt16BE(head.length);
    const b = Buffer.concat([h, head, Buffer.from([9, 8, 7])]);
    let n = 0;
    const connect = (): WebSocketLike => {
      const s: WebSocketLike = {
        onopen: null, onmessage: null, onerror: null, onclose: null, close: () => {},
        send: () => {
          if (++n < 2) return;
          s.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
          s.onmessage?.({ data: `Path:audio.metadata\r\n\r\n{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":0,"Duration":5000000,"text":{"Text":"Hi"}}}]}` });
          s.onmessage?.({ data: "Path:turn.end\r\n\r\n{}" });
        },
      };
      queueMicrotask(() => s.onopen?.({}));
      return s;
    };
    const ctx = { claim: { stageRunId: "r" }, attemptDir: dir, signal: new AbortController().signal, log: () => {} } as unknown as StageContext;
    const r = await createEdgeVoice({ connect }).synthesise(ctx, { text: "Hi", lang: "en", voice: "en-US-AriaNeural" });
    expect(path.dirname(r.audioPath)).toBe(dir);
    expect([...readFileSync(r.audioPath)]).toEqual([9, 8, 7]);
    expect(r.wordTimings).toEqual([{ word: "Hi", startS: 0, endS: 0.5 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
