// Fixtures are hand-written from Kling's public docs and are `unrecorded`: no real call has been made. Everything runs against a local HTTP server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { classifyError, NotProcessedError } from "@/server/core/error-class";
import { uuidv7 } from "@/server/core/ids";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { submitOnce } from "@/server/db/media-jobs";
import { pickVideoModel, type ClipArgs } from "@/server/providers/video";
import { createKlingJobChecker, createKlingVideo, KLING_MODELS } from "@/server/providers/video/kling";
import { FAKE_MP4 } from "@/server/providers/video/fake";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { withTestDb, type TestDb } from "../support/db";

const KEY = "kl-SECRET-key-1234567890";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
const PRICE = { unit: "per_second", microUsd: 50_000 } as const;
const MODEL = "kling-4.0";
const TASK = "task-8f3a1c2d";
const VIDEO_URL = "https://cdn.example-kling.com/out/clip.mp4";
const BUDGET = ["video:t"];

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let port: number;
let handler: Handler;
let seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
let db: TestDb;
let dir: string;
let root: string;
let ctl: AbortController;
let steps: number;
let sleeps: number[];

const json = (res: ServerResponse, status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
const localFetch: SafeFetch = (url, init) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-orig-host": u.host } });
};
const ctxFor = (stageRunId = uuidv7()): StageContext => ({
  claim: { stageRunId }, attemptDir: dir, signal: ctl.signal, config: buildEngineConfig(new Map()), nextStep: () => steps++,
  paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call(`${stageRunId}:${steps++}:0`, ctl.signal)).result,
}) as unknown as StageContext;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "kl-")));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "kl-root-")));
  db = await withTestDb();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { const body = Buffer.concat(chunks).toString(); seen.push({ method: req.method!, url: req.url!, headers: req.headers, body }); handler(req, body, res); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  seen = []; steps = 0; sleeps = []; ctl = new AbortController();
  for (const d of [dir, root]) for (const f of readdirSync(d)) rmSync(path.join(d, f), { recursive: true, force: true });
  handler = (_r, _b, res) => json(res, 500, {});
});

const kling = (price: unknown = PRICE, extra: { fetchCdn?: SafeFetch; resolution?: "720p" | "1080p" } = {}) =>
  createKlingVideo({ fetch: localFetch, fetchCdn: extra.fetchCdn ?? localFetch, db: db.pool, getKey: async () => KEY, price, root, resolution: extra.resolution,
    readImage: async (p) => (p === "bad.png" ? HTML : PNG), sleep: async (ms) => { sleeps.push(ms); } });
const args = (o: Partial<ClipArgs> = {}): ClipArgs => ({ prompt: "a red fox runs", seconds: 5, aspect: "9:16", startImage: false, endImage: false, model: MODEL, budgetScopes: BUDGET, ...o });

// A well-behaved server; `over` replaces single routes. Kling creates at /<kind>/<model> and lists tasks at GET /tasks?task_ids=ID.
function server_(over: { submit?: Handler; task?: Handler; file?: Handler } = {}) {
  handler = (req, body, res) => {
    const u = req.url!;
    if (req.method === "POST" && /^\/(image|text)-to-video\/kling-(3\.0|4\.0)$/.test(u)) return (over.submit ?? ((_r, _b, s) => json(s, 200, { code: 0, data: { id: TASK, status: "submitted" } })))(req, body, res);
    if (req.method === "GET" && u === `/tasks?task_ids=${TASK}`) return (over.task ?? ((_r, _b, s) => json(s, 200, { code: 0, data: [{ id: TASK, status: "succeeded", outputs: [{ type: "video", url: VIDEO_URL }] }] })))(req, body, res);
    if (u === "/out/clip.mp4") return (over.file ?? ((_r, _b, s) => { s.writeHead(200, { "content-type": "video/mp4" }); s.end(FAKE_MP4); }))(req, body, res);
    json(res, 404, {});
  };
}
const taskBody = (t: Record<string, unknown>) => ({ code: 0, data: [{ id: TASK, ...t }] });

describe("a normal clip", () => {
  it("from a picture: image-to-video body with first_frame, no key to the file host, stored with the quoted price", async () => {
    server_();
    const art = await kling().generate(ctxFor(), args({ startImage: true, startImagePath: "frames/a.png" }));
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.url).toBe("/image-to-video/kling-4.0");
    expect(post.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(post.body);
    expect(body.contents[0]).toEqual({ type: "prompt", text: "a red fox runs" });
    expect(body.contents[1]).toMatchObject({ type: "first_frame" });
    expect(body.contents[1].url).toMatch(/^data:image\/png;base64,/);
    expect(body.settings).toEqual({ duration: 5, resolution: "720p" });
    expect(body.options).toEqual({ watermark_info: { enabled: false } });
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
    expect(seen.find((s) => s.url === "/out/clip.mp4")!.headers.authorization).toBeUndefined();
    expect(art.provenance).toMatchObject({ provider: "kling_video", model: MODEL, priceMicroUsd: 250_000, quoted: true });
    expect(readFileSync(art.path)).toEqual(FAKE_MP4);
  });
  it("from words (4.0 only): text-to-video with the shape in settings", async () => {
    server_();
    await kling().generate(ctxFor(), args({ aspect: "16:9" }));
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.url).toBe("/text-to-video/kling-4.0");
    expect(JSON.parse(post.body)).toMatchObject({ prompt: "a red fox runs", settings: { aspect_ratio: "16:9", duration: 5, resolution: "720p" } });
  });
  it("3.0 switches its own sound off and refuses a words-only clip; first and last frame are sent in order", async () => {
    server_();
    await expect(kling().generate(ctxFor(), args({ model: "kling-3.0" }))).rejects.toThrow(/needs a start picture/);
    expect(seen).toHaveLength(0);
    await kling(PRICE, { resolution: "1080p" }).generate(ctxFor(), args({ model: "kling-3.0", startImage: true, endImage: true, startImagePath: "a.png", endImagePath: "b.png" }));
    const body = JSON.parse(seen.find((s) => s.method === "POST")!.body);
    expect(seen.find((s) => s.method === "POST")!.url).toBe("/image-to-video/kling-3.0");
    expect(body.settings).toEqual({ duration: 5, resolution: "1080p", audio: "off" });
    expect(body.contents.map((c: { type: string }) => c.type)).toEqual(["prompt", "first_frame", "last_frame"]);
  });
  it("polls while submitted or processing, then finishes", async () => {
    let n = 0;
    server_({ task: (_r, _b, s) => json(s, 200, ++n < 3 ? taskBody({ status: n === 1 ? "submitted" : "processing" }) : taskBody({ status: "succeeded", outputs: [{ type: "video", url: VIDEO_URL }] })) });
    const art = await kling().generate(ctxFor(), args());
    expect(art.sha256).toHaveLength(64);
    expect(n).toBe(3);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(2000);
  });
  it("takes the output that is a video, not the first output", async () => {
    server_({ task: (_r, _b, s) => json(s, 200, taskBody({ status: "succeeded", outputs: [{ type: "image", url: "https://cdn.example-kling.com/out/cover.png" }, { type: "video", url: VIDEO_URL }] })) });
    expect((await kling().generate(ctxFor(), args())).sha256).toHaveLength(64);
  });
});

describe("refusals before any money or request", () => {
  it("unpriced, wrong model, bad length, no budget, missing picture file are refused and nothing is sent", async () => {
    server_();
    await expect(kling(null).generate(ctxFor(), args())).rejects.toBeInstanceOf(KnownFailure);
    await expect(kling().generate(ctxFor(), args({ model: "kling-9" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(kling().generate(ctxFor(), args({ seconds: 2 }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(kling().generate(ctxFor(), args({ seconds: 31 }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(kling().generate(ctxFor(), args({ budgetScopes: [] }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(kling().generate(ctxFor(), args({ startImage: true }))).rejects.toBeInstanceOf(KnownFailure); // announced, not given
    await expect(kling().generate(ctxFor(), args({ startImage: true, startImagePath: "bad.png" }))).rejects.toBeInstanceOf(KnownFailure); // not an image
    expect(seen).toHaveLength(0);
  });
  it("quote is the owner's per-second price times the length, and a locked character needs a picture-capable model", () => {
    expect(kling().quote(args())).toBe(250_000);
    const all = { kling_video: kling() };
    expect(pickVideoModel(all, "kling_video", MODEL, { locked: true }).model.imageToVideo).toBe(true);
    for (const m of Object.values(KLING_MODELS)) expect(m.minSeconds).toBe(3);
  });
});

describe("error matrix (money rules)", () => {
  const run = () => kling().generate(ctxFor(), args());
  const expectClass = async (cls: string, plainUnknown: boolean) => {
    const e = await run().then(() => null, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(classifyError(e)).toBe(cls);
    if (plainUnknown) expect(e).not.toBeInstanceOf(KnownFailure);
    expect(String((e as Error).message)).not.toContain(KEY);
  };
  it.each([400, 401, 403, 422])("%i on submit is rejected before work: permanent", async (st) => {
    server_({ submit: (_r, _b, s) => json(s, st, { error: { code: "InvalidParameter" } }) });
    await expectClass("permanent", false);
    expect(await run().catch((x) => x)).toBeInstanceOf(NotProcessedError);
  });
  it("429 is transient", async () => {
    server_({ submit: (_r, _b, s) => json(s, 429, {}) });
    await expectClass("transient", false);
  });
  it.each([408, 500, 502, 503])("%i on submit is unknown (parks)", async (st) => {
    server_({ submit: (_r, _b, s) => json(s, st, {}) });
    await expectClass("unknown", true);
  });
  it("socket lost after send, an empty answer and a bad job id are unknown", async () => {
    server_({ submit: (r) => r.socket.destroy() });
    await expectClass("unknown", true);
    server_({ submit: (_r, _b, s) => { s.writeHead(200); s.end(); } });
    await expectClass("unknown", true);
    server_({ submit: (_r, _b, s) => json(s, 200, { code: 0, data: { id: "../../x" } }) });
    await expectClass("unknown", true);
  });
  it("a failed task, an unknown status, no task listed, a missing, non-https or credentialed file address are unknown, never refunds", async () => {
    const ok = { type: "video", url: VIDEO_URL };
    const bad: unknown[] = [taskBody({ status: "failed" }), taskBody({ status: "mystery" }), { code: 0, data: [] }, taskBody({ status: "succeeded", outputs: [] }),
      taskBody({ status: "succeeded", outputs: [{ type: "video", url: "http://x.example/a.mp4" }] }), taskBody({ status: "succeeded", outputs: [{ type: "video", url: "https://u:p@x.example/a.mp4" }] }),
      taskBody({ status: "succeeded", outputs: [{ type: "video", url: "https://x.example:8443/a.mp4" }] })];
    expect(ok.type).toBe("video");
    for (const task of bad) {
      server_({ task: (_r, _b, s) => json(s, 200, task) });
      await expectClass("unknown", true);
      steps = 0;
      await db.reset();
    }
  });
  it("a file that is not an MP4 is unknown and nothing is stored", async () => {
    server_({ file: (_r, _b, s) => { s.writeHead(200); s.end(HTML); } });
    await expectClass("unknown", true);
    expect(readdirSync(root, { recursive: true })).toEqual([]);
  });
  it("three failed polls in a row park it; one failed poll is tolerated", async () => {
    let n = 0;
    server_({ task: (_r, _b, s) => (++n === 1 ? json(s, 500, {}) : json(s, 200, taskBody({ status: "succeeded", outputs: [{ type: "video", url: VIDEO_URL }] }))) });
    await run();
    await db.reset();
    steps = 0;
    server_({ task: (_r, _b, s) => json(s, 500, {}) });
    await expectClass("unknown", true);
  });
  it("the key goes in a header, never in a URL, and the prompt never in a URL", async () => {
    server_();
    await run();
    for (const s of seen) {
      expect(s.url).not.toContain(KEY);
      expect(decodeURIComponent(s.url)).not.toContain("red fox");
    }
  });
});

describe("restart safety and the job checker", () => {
  it("a resume with a stored job id only polls: the submit is never repeated", async () => {
    server_();
    const run = uuidv7();
    const first = await kling().generate(ctxFor(run), args());
    steps = 0;
    const second = await kling().generate(ctxFor(run), args());
    expect(second.sha256).toBe(first.sha256);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });
  it("a submit whose id was lost is never resubmitted", async () => {
    server_();
    const run = uuidv7();
    await submitOnce(db.pool, { stageRunId: run, step: 0 }, "kling_video", "video", 250_000); // row written, id never stored
    const e = await kling().generate(ctxFor(run), args()).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
  it("the checker is read only: running, done, failed on a clear 404, unknown otherwise", async () => {
    const checker = createKlingJobChecker({ fetch: localFetch, fetchCdn: localFetch, getKey: async () => KEY, root });
    const job = { providerJobId: TASK, quoteMicroUsd: 250_000 };
    server_({ task: (_r, _b, s) => json(s, 200, taskBody({ status: "processing" })) });
    expect(await checker.check(job)).toEqual({ kind: "running" });
    server_();
    expect((await checker.check(job)).kind).toBe("done");
    server_({ task: (_r, _b, s) => json(s, 404, {}) });
    expect((await checker.check(job)).kind).toBe("failed");
    server_({ task: (_r, _b, s) => json(s, 500, {}) });
    expect((await checker.check(job)).kind).toBe("unknown");
    expect((await checker.check({ providerJobId: "../x", quoteMicroUsd: 1 })).kind).toBe("unknown");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});
