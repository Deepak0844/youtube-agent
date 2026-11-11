// Fixtures are hand-written from BytePlus ModelArk's public docs and are `unrecorded`: no real call has been made. Everything runs against a local HTTP server.
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
import { createSeedanceJobChecker, createSeedanceVideo, SEEDANCE_MODELS } from "@/server/providers/video/seedance";
import { FAKE_MP4 } from "@/server/providers/video/fake";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { withTestDb, type TestDb } from "../support/db";

const KEY = "sk-seedance-SECRET-key-123456";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
const PRICE = { unit: "per_second", microUsd: 50_000 } as const;
const MODEL = "dreamina-seedance-2-0-fast-260128";
const TASK = "cgt-20261111-abcd1234";
const VIDEO_URL = "https://cdn.example-bytepluses.com/out/clip.mp4";
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
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sd-")));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "sd-root-")));
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

const seedance = (price: unknown = PRICE, extra: { fetchCdn?: SafeFetch; resolution?: "480p" | "720p" | "1080p" } = {}) =>
  createSeedanceVideo({ fetch: localFetch, fetchCdn: extra.fetchCdn ?? localFetch, db: db.pool, getKey: async () => KEY, price, root, resolution: extra.resolution,
    readImage: async (p) => (p === "bad.png" ? HTML : PNG), sleep: async (ms) => { sleeps.push(ms); } });
const args = (o: Partial<ClipArgs> = {}): ClipArgs => ({ prompt: "a red fox runs", seconds: 5, aspect: "9:16", startImage: false, endImage: false, model: MODEL, budgetScopes: BUDGET, ...o });

// A well-behaved server; `over` replaces single routes.
function server_(over: { submit?: Handler; task?: Handler; file?: Handler } = {}) {
  handler = (req, body, res) => {
    const u = req.url!;
    if (req.method === "POST" && u === "/api/v3/contents/generations/tasks") return (over.submit ?? ((_r, _b, s) => json(s, 200, { id: TASK })))(req, body, res);
    if (req.method === "GET" && u === `/api/v3/contents/generations/tasks/${TASK}`) return (over.task ?? ((_r, _b, s) => json(s, 200, { id: TASK, status: "succeeded", content: { video_url: VIDEO_URL } })))(req, body, res);
    if (u === "/out/clip.mp4") return (over.file ?? ((_r, _b, s) => { s.writeHead(200, { "content-type": "video/mp4" }); s.end(FAKE_MP4); }))(req, body, res);
    json(res, 404, {});
  };
}

describe("a normal clip", () => {
  it("submits once with the documented body, polls, downloads without the key, and stores the clip with the quoted price", async () => {
    server_();
    const art = await seedance().generate(ctxFor(), args({ startImage: true, startImagePath: "frames/a.png" }));
    const post = seen.find((s) => s.method === "POST")!;
    expect(post.headers.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(post.body);
    expect(body).toMatchObject({ model: MODEL, resolution: "720p", ratio: "9:16", duration: 5, generate_audio: false, watermark: false });
    expect(body.content[0]).toEqual({ type: "text", text: "a red fox runs" });
    expect(body.content[1]).toMatchObject({ type: "image_url", role: "first_frame" });
    expect(body.content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
    const file = seen.find((s) => s.url === "/out/clip.mp4")!;
    expect(file.headers.authorization).toBeUndefined();
    expect(art.provenance).toMatchObject({ provider: "seedance_video", model: MODEL, priceMicroUsd: 250_000, quoted: true });
    expect(art.durationS).toBe(5);
    expect(readFileSync(art.path)).toEqual(FAKE_MP4);
  });
  it("sends first and last frame roles, a chosen resolution, and no audio", async () => {
    server_();
    await seedance(PRICE, { resolution: "1080p" }).generate(ctxFor(), args({ startImage: true, endImage: true, startImagePath: "a.png", endImagePath: "b.png" }));
    const body = JSON.parse(seen.find((s) => s.method === "POST")!.body);
    expect(body.resolution).toBe("1080p");
    expect(body.content.map((c: { role?: string }) => c.role)).toEqual([undefined, "first_frame", "last_frame"]);
  });
  it("polls while queued or running, then finishes", async () => {
    let n = 0;
    server_({ task: (_r, _b, s) => json(s, 200, ++n < 3 ? { status: n === 1 ? "queued" : "running" } : { status: "succeeded", content: { video_url: VIDEO_URL } }) });
    const art = await seedance().generate(ctxFor(), args());
    expect(art.sha256).toHaveLength(64);
    expect(n).toBe(3);
    expect(sleeps.length).toBe(2);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(2000);
  });
});

describe("refusals before any money or request", () => {
  it("unpriced, wrong model, bad length, no budget, missing picture file are refused and nothing is sent", async () => {
    server_();
    await expect(seedance(null).generate(ctxFor(), args())).rejects.toBeInstanceOf(KnownFailure);
    await expect(seedance().generate(ctxFor(), args({ model: "seedance-9" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(seedance().generate(ctxFor(), args({ seconds: 2 }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(seedance().generate(ctxFor(), args({ seconds: 31, model: "dreamina-seedance-2-5-260628" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(seedance().generate(ctxFor(), args({ budgetScopes: [] }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(seedance().generate(ctxFor(), args({ startImage: true }))).rejects.toBeInstanceOf(KnownFailure); // announced, not given
    await expect(seedance().generate(ctxFor(), args({ startImage: true, startImagePath: "bad.png" }))).rejects.toBeInstanceOf(KnownFailure); // not an image
    expect(seen).toHaveLength(0);
  });
  it("quote is the owner's per-second price times the length, and a locked character needs a picture-capable model", () => {
    expect(seedance().quote(args())).toBe(250_000);
    const all = { seedance_video: seedance() };
    expect(pickVideoModel(all, "seedance_video", MODEL, { locked: true }).model.imageToVideo).toBe(true);
    for (const m of Object.values(SEEDANCE_MODELS)) expect(m.minSeconds).toBe(4);
  });
});

describe("error matrix (money rules)", () => {
  const run = () => seedance().generate(ctxFor(), args());
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
    server_({ submit: (_r, _b, s) => json(s, 200, { id: "../../x" }) });
    await expectClass("unknown", true);
  });
  it("a failed task, an unknown status, a missing or non-https or credentialed file address are unknown, never refunds", async () => {
    for (const task of [{ status: "failed" }, { status: "mystery" }, { status: "succeeded", content: {} }, { status: "succeeded", content: { video_url: "http://x.example/a.mp4" } }, { status: "succeeded", content: { video_url: "https://u:p@x.example/a.mp4" } }, { status: "succeeded", content: { video_url: "https://x.example:8443/a.mp4" } }]) {
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
    server_({ task: (_r, _b, s) => (++n === 1 ? json(s, 500, {}) : json(s, 200, { status: "succeeded", content: { video_url: VIDEO_URL } })) });
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
    const first = await seedance().generate(ctxFor(run), args());
    steps = 0;
    const second = await seedance().generate(ctxFor(run), args());
    expect(second.sha256).toBe(first.sha256);
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(1);
  });
  it("a submit whose id was lost is never resubmitted", async () => {
    server_();
    const run = uuidv7();
    await submitOnce(db.pool, { stageRunId: run, step: 0 }, "seedance_video", "video", 250_000); // row written, id never stored
    const e = await seedance().generate(ctxFor(run), args()).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
  it("the checker is read only: running, done, failed on a clear 404, unknown otherwise", async () => {
    const checker = createSeedanceJobChecker({ fetch: localFetch, fetchCdn: localFetch, getKey: async () => KEY, root });
    const job = { providerJobId: TASK, quoteMicroUsd: 250_000 };
    server_({ task: (_r, _b, s) => json(s, 200, { status: "running" }) });
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
