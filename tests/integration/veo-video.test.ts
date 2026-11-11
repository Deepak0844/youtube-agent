// Fixtures are hand-written from Google's public Veo docs (Vertex AI) and are `unrecorded`: no real call has been made. Everything runs against a local HTTP server.
import { generateKeyPairSync } from "node:crypto";
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
import { createVeoJobChecker, createVeoVideo, VEO_MODELS } from "@/server/providers/video/veo";
import { FAKE_MP4 } from "@/server/providers/video/fake";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { withTestDb, type TestDb } from "../support/db";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
const KEY = JSON.stringify({ type: "service_account", project_id: "my-video-project", client_email: "bot@my-video-project.iam.gserviceaccount.com", private_key: PEM });
const TOKEN = "ya29.test-access-token-abcdefghijklmnop";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
const PRICE = { unit: "per_second", microUsd: 50_000 } as const;
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
const MODEL = "veo-3.1-fast-generate-001";
const MODELS_PATH = "/v1/projects/my-video-project/locations/us-central1/publishers/google/models";
const OP = `projects/my-video-project/locations/us-central1/publishers/google/models/${MODEL}/operations/0a1b2c3d-1111-2222-3333-444455556666`;
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
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "vo-")));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "vo-root-")));
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

const veo = (price: unknown = PRICE, extra: { resolution?: "720p" | "1080p" } = {}) =>
  createVeoVideo({ fetch: localFetch, db: db.pool, getKey: async () => KEY, price, root, resolution: extra.resolution, now: () => 1_700_000_000_000,
    readImage: async (p) => (p === "bad.png" ? HTML : p === "webp.webp" ? WEBP : PNG), sleep: async (ms) => { sleeps.push(ms); } });
const args = (o: Partial<ClipArgs> = {}): ClipArgs => ({ prompt: "a red fox runs", seconds: 4, aspect: "9:16", startImage: false, endImage: false, model: MODEL, budgetScopes: BUDGET, ...o });

const done = (over: Record<string, unknown> = {}) => ({ name: OP, done: true, response: { videos: [{ bytesBase64Encoded: FAKE_MP4.toString("base64"), mimeType: "video/mp4" }], raiMediaFilteredCount: 0 }, ...over });
// A well-behaved server; `over` replaces single routes. The sign-in is POST /token, the clip POST .../MODEL:predictLongRunning, the poll POST .../MODEL:fetchPredictOperation.
function server_(over: { token?: Handler; submit?: Handler; poll?: Handler } = {}) {
  handler = (req, body, res) => {
    const u = req.url!;
    if (req.method === "POST" && u === "/token") return (over.token ?? ((_r, _b, s) => json(s, 200, { access_token: TOKEN, expires_in: 3600 })))(req, body, res);
    if (req.method === "POST" && u === `${MODELS_PATH}/${MODEL}:predictLongRunning`) return (over.submit ?? ((_r, _b, s) => json(s, 200, { name: OP })))(req, body, res);
    if (req.method === "POST" && u === `${MODELS_PATH}/${MODEL}:fetchPredictOperation`) return (over.poll ?? ((_r, _b, s) => json(s, 200, done())))(req, body, res);
    json(res, 404, {});
  };
}

describe("a normal clip", () => {
  it("signs in, submits once with the documented body, polls, and stores the inline video with the quoted price", async () => {
    server_();
    const art = await veo().generate(ctxFor(), args({ startImage: true, startImagePath: "frames/a.png" }));
    const token = seen.find((s) => s.url === "/token")!;
    expect(token.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(token.body).not.toContain("PRIVATE KEY");
    const post = seen.find((s) => s.url.endsWith(":predictLongRunning"))!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(post.body);
    expect(body.instances[0].prompt).toBe("a red fox runs");
    expect(body.instances[0].image).toMatchObject({ mimeType: "image/png" });
    expect(body.instances[0].image.bytesBase64Encoded).toBe(PNG.toString("base64"));
    expect(body.parameters).toEqual({ aspectRatio: "9:16", durationSeconds: 4, resolution: "720p", sampleCount: 1, generateAudio: false });
    expect(body.parameters.storageUri).toBeUndefined();
    expect(seen.filter((s) => s.url.endsWith(":predictLongRunning"))).toHaveLength(1);
    expect(JSON.parse(seen.find((s) => s.url.endsWith(":fetchPredictOperation"))!.body)).toEqual({ operationName: OP });
    expect(art.provenance).toMatchObject({ provider: "veo_video", model: MODEL, priceMicroUsd: 200_000, quoted: true });
    expect(readFileSync(art.path)).toEqual(FAKE_MP4);
  });
  it("text only is allowed; the project and model come from the saved file and the request", async () => {
    server_();
    await veo().generate(ctxFor(), args({ aspect: "16:9", seconds: 8 }));
    const post = seen.find((s) => s.url.endsWith(":predictLongRunning"))!;
    expect(post.url).toBe(`${MODELS_PATH}/${MODEL}:predictLongRunning`);
    expect(JSON.parse(post.body).instances[0].image).toBeUndefined();
    expect(JSON.parse(post.body).parameters).toMatchObject({ aspectRatio: "16:9", durationSeconds: 8 });
  });
  it("polls while not done, then finishes", async () => {
    let n = 0;
    server_({ poll: (_r, _b, s) => json(s, 200, ++n < 3 ? { name: OP, done: false } : done()) });
    const art = await veo().generate(ctxFor(), args());
    expect(art.sha256).toHaveLength(64);
    expect(n).toBe(3);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(2000);
  });
  it("renews the sign-in when a long wait passes 45 minutes", async () => {
    let clock = 1_700_000_000_000;
    let n = 0;
    server_({ poll: (_r, _b, s) => { clock += 50 * 60_000; json(s, 200, ++n < 2 ? { name: OP, done: false } : done()); } });
    const v = createVeoVideo({ fetch: localFetch, db: db.pool, getKey: async () => KEY, price: PRICE, root, readImage: async () => PNG, now: () => clock, sleep: async () => undefined });
    await v.generate(ctxFor(), args());
    expect(seen.filter((s) => s.url === "/token").length).toBeGreaterThanOrEqual(2);
  });
});

describe("refusals before any money or request", () => {
  it("unpriced, wrong model, lengths Veo does not make, no budget, bad or webp or missing picture are refused and nothing is sent", async () => {
    server_();
    await expect(veo(null).generate(ctxFor(), args())).rejects.toBeInstanceOf(KnownFailure);
    await expect(veo().generate(ctxFor(), args({ model: "veo-9" }))).rejects.toBeInstanceOf(KnownFailure);
    for (const seconds of [3, 9]) await expect(veo().generate(ctxFor(), args({ seconds }))).rejects.toThrow(/4 to 8/);
    for (const seconds of [5, 7]) await expect(veo().generate(ctxFor(), args({ seconds }))).rejects.toThrow(/4, 6, 8/);
    await expect(veo().generate(ctxFor(), args({ aspect: "1:1" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(veo().generate(ctxFor(), args({ budgetScopes: [] }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(veo().generate(ctxFor(), args({ endImage: true, startImage: true, startImagePath: "a.png", endImagePath: "b.png" }))).rejects.toThrow(/end picture/);
    await expect(veo().generate(ctxFor(), args({ startImage: true }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(veo().generate(ctxFor(), args({ startImage: true, startImagePath: "bad.png" }))).rejects.toBeInstanceOf(KnownFailure);
    await expect(veo().generate(ctxFor(), args({ startImage: true, startImagePath: "webp.webp" }))).rejects.toThrow(/PNG or JPEG/);
    expect(seen).toHaveLength(0);
  });
  it("quote is the owner's per-second price times the length; a locked character may use any Veo model", () => {
    expect(veo().quote(args())).toBe(200_000);
    expect(pickVideoModel({ veo_video: veo() }, "veo_video", MODEL, { locked: true }).model.imageToVideo).toBe(true);
    for (const m of Object.values(VEO_MODELS)) expect(m.allowedSeconds).toEqual([4, 6, 8]);
  });
  it("a bad saved file or a refused sign-in stops before the clip is submitted, and the money is released", async () => {
    server_();
    const badFile = createVeoVideo({ fetch: localFetch, db: db.pool, getKey: async () => "not json", price: PRICE, root, readImage: async () => PNG });
    expect(await badFile.generate(ctxFor(), args()).catch((x) => x)).toBeInstanceOf(NotProcessedError);
    server_({ token: (_r, _b, s) => json(s, 401, { error: "invalid_grant" }) });
    const e = await veo().generate(ctxFor(), args()).catch((x) => x);
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(classifyError(e)).toBe("permanent");
    expect(seen.filter((s) => s.url.includes("predictLongRunning"))).toHaveLength(0);
  });
});

describe("error matrix (money rules)", () => {
  const run = () => veo().generate(ctxFor(), args());
  const expectClass = async (cls: string, plainUnknown: boolean) => {
    const e = await run().then(() => null, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(classifyError(e)).toBe(cls);
    if (plainUnknown) expect(e).not.toBeInstanceOf(KnownFailure);
    expect(String((e as Error).message)).not.toContain("PRIVATE KEY");
    expect(String((e as Error).message)).not.toContain(TOKEN);
  };
  it.each([400, 401, 403, 404])("%i on submit is rejected before work: permanent", async (st) => {
    server_({ submit: (_r, _b, s) => json(s, st, { error: { status: "INVALID_ARGUMENT" } }) });
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
  it("socket lost after send, an empty answer, a bad or foreign job name are unknown", async () => {
    server_({ submit: (r) => r.socket.destroy() });
    await expectClass("unknown", true);
    server_({ submit: (_r, _b, s) => { s.writeHead(200); s.end(); } });
    await expectClass("unknown", true);
    server_({ submit: (_r, _b, s) => json(s, 200, { name: "../../x" }) });
    await expectClass("unknown", true);
    server_({ submit: (_r, _b, s) => json(s, 200, { name: OP.replace(MODEL, "veo-3.1-generate-001") }) }); // an operation of another model
    await expectClass("unknown", true);
  });
  it("a reported error, a video-less finish (filtered), a non-base64 and an empty video are unknown, never refunds", async () => {
    for (const op of [done({ error: { code: 3 } }), done({ response: { videos: [], raiMediaFilteredCount: 1 } }), done({ response: {} }), done({ response: { videos: [{ gcsUri: "gs://b/x.mp4" }] } }), done({ response: { videos: [{ bytesBase64Encoded: "" }] } })]) {
      server_({ poll: (_r, _b, s) => json(s, 200, op) });
      await expectClass("unknown", true);
      steps = 0;
      await db.reset();
    }
  });
  it("bytes that are not an MP4 are unknown and nothing is stored", async () => {
    server_({ poll: (_r, _b, s) => json(s, 200, done({ response: { videos: [{ bytesBase64Encoded: HTML.toString("base64") }] } })) });
    await expectClass("unknown", true);
    expect(readdirSync(root, { recursive: true })).toEqual([]);
  });
  it("three failed polls in a row park it; one failed poll is tolerated", async () => {
    let n = 0;
    server_({ poll: (_r, _b, s) => (++n === 1 ? json(s, 500, {}) : json(s, 200, done())) });
    await run();
    await db.reset();
    steps = 0;
    server_({ poll: (_r, _b, s) => json(s, 500, {}) });
    await expectClass("unknown", true);
  });
  it("the token goes in a header, never in a URL, and the prompt never in a URL", async () => {
    server_();
    await run();
    for (const s of seen) {
      expect(s.url).not.toContain(TOKEN);
      expect(decodeURIComponent(s.url)).not.toContain("red fox");
    }
  });
});

describe("restart safety and the job checker", () => {
  it("a resume with a stored job name only polls: the submit is never repeated", async () => {
    server_();
    const run = uuidv7();
    const first = await veo().generate(ctxFor(run), args());
    steps = 0;
    const second = await veo().generate(ctxFor(run), args());
    expect(second.sha256).toBe(first.sha256);
    expect(seen.filter((s) => s.url.endsWith(":predictLongRunning"))).toHaveLength(1);
  });
  it("a submit whose job name was lost is never resubmitted", async () => {
    server_();
    const run = uuidv7();
    await submitOnce(db.pool, { stageRunId: run, step: 0 }, "veo_video", "video", 200_000);
    const e = await veo().generate(ctxFor(run), args()).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(seen.filter((s) => s.url.endsWith(":predictLongRunning"))).toHaveLength(0);
  });
  it("the checker is read only: running, done, failed on a reported error, unknown otherwise", async () => {
    const checker = createVeoJobChecker({ fetch: localFetch, getKey: async () => KEY, root, now: () => 1_700_000_000_000 });
    const job = { providerJobId: OP, quoteMicroUsd: 200_000 };
    server_({ poll: (_r, _b, s) => json(s, 200, { name: OP, done: false }) });
    expect(await checker.check(job)).toEqual({ kind: "running" });
    server_();
    expect((await checker.check(job)).kind).toBe("done");
    server_({ poll: (_r, _b, s) => json(s, 200, done({ error: { code: 13 } })) });
    expect((await checker.check(job)).kind).toBe("failed");
    server_({ poll: (_r, _b, s) => json(s, 500, {}) });
    expect((await checker.check(job)).kind).toBe("unknown");
    expect((await checker.check({ providerJobId: "../x", quoteMicroUsd: 1 })).kind).toBe("unknown");
    expect(seen.filter((s) => s.url.endsWith(":predictLongRunning"))).toHaveLength(0);
  });
});
