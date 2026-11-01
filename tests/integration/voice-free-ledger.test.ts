// A free VoiceStudio synth through the REAL paid-call ports (no fakes): reserve 0 on the video's scopes, settle 0, no throw.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { createStageContext } from "@/server/core/stage-handler";
import { createPgPaidCallPorts } from "@/server/db/paid-call-adapter";
import { claimStage, insertQueuedStage } from "@/server/db/stages";
import { createVideoRow } from "@/server/db/videos";
import { createVoiceStudioVoice } from "@/server/providers/voice/voicestudio";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let dir: string;
let server: Server;
let base: string;
beforeAll(async () => {
  db = await withTestDb();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "voice-free-")));
  const n = 800;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(1000, 24); h.writeUInt32LE(1000, 28);
  h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  const wav = Buffer.concat([h, Buffer.alloc(n, 128)]);
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/audio/speech") { res.writeHead(200, { "content-type": "audio/wav" }); res.end(wav); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "x", words: [{ word: "Hello", start: 0, end: 0.4 }, { word: "there.", start: 0.4, end: 0.8 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.pool.query("insert into budgets (scope, cap_micro_usd) values ('day', 15000000), ('month', 100000000)");
});

describe("free voice through the real ledger", () => {
  it("VoiceStudio synth creates a settled amount-0 spend_intent and does not throw", async () => {
    const v = await createVideoRow(db.pool, { format: "short", kind: "scene_kit", language: "en", topic: "t" });
    const stageId = await insertQueuedStage(db.pool, { videoId: v.id, name: "tts", inputHash: "h" });
    const claim = (await claimStage(db.pool, { id: stageId, inputHash: "h", workerId: "w1", ttlMs: 600_000 }))!;
    const made = createStageContext({ stage: { id: stageId, name: "tts", inputHash: "h", videoId: v.id }, claim, config: buildEngineConfig(new Map()), signal: new AbortController().signal, paid: createPgPaidCallPorts(db.pool) }).ctx;
    const ctx = { ...made, attemptDir: dir };
    const voice = createVoiceStudioVoice({ baseUrl: base, localServices: [new URL(base).host], voice: "v", budgetScopes: ["day", "month"] });
    const r = await voice.synthesise(ctx, { text: "Hello there.", lang: "en", voice: "v" });
    expect(r.priceMicroUsd).toBe(0);
    const rows = (await db.pool.query("select status, reserved_micro_usd r, actual_micro_usd a, scopes from spend_intents")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "done", scopes: ["day", "month"] });
    expect(Number(rows[0].r)).toBe(0);
    expect(Number(rows[0].a)).toBe(0);
    const b = (await db.pool.query("select scope, reserved_micro_usd r, spent_micro_usd s from budgets")).rows;
    for (const row of b) expect([Number(row.r), Number(row.s)]).toEqual([0, 0]);
  });
});
