// Fixtures below are hand-written from the public provider docs (Gemini Interactions API, OpenAI Image API, fal queue API)
// and are `unrecorded`: no real call has been made. Everything runs against a local HTTP server.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { uuidv7 } from "@/server/core/ids";
import { classifyError, NotProcessedError, type ErrorClass } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { submitOnce } from "@/server/db/media-jobs";
import type { ImageProvider } from "@/server/providers/media";
import { createFalImage } from "@/server/providers/image/fal";
import { createGeminiImage } from "@/server/providers/image/gemini";
import { pickImageProvider, saveImage } from "@/server/providers/image";
import { createOpenAIImage } from "@/server/providers/image/openai";
import type { SafeFetch } from "@/server/providers/voice/eleven-types";
import { withTestDb, type TestDb } from "../support/db";

const KEY = "sk-test-SECRET-key-123";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const HTML = Buffer.from("<!doctype html><html><script>alert(1)</script></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
const PRICE = { unit: "per_image", microUsd: 33_600 } as const;
const FAL_PRICE = { unit: "per_image", microUsd: 3000 } as const;

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let server: Server;
let port: number;
let handler: Handler;
let seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }>;
let db: TestDb;
let dir: string;
let ctl: AbortController;
let steps: number;
let sleeps: number[];

const json = (res: ServerResponse, status: number, v: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };

// Rewrites the typed https host to the local server; the adapter still builds the real URL.
const localFetch: SafeFetch = (url, init) => {
  const u = new URL(url);
  return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-orig-host": u.host } });
};

const ctxFor = (stageRunId = uuidv7()): StageContext => ({
  claim: { stageRunId }, attemptDir: dir, signal: ctl.signal, config: buildEngineConfig(new Map()),
  nextStep: () => steps++,
  paid: async (_s: unknown, call: (k: string, s: AbortSignal) => Promise<{ result: unknown }>) => (await call(`${stageRunId}:${steps++}:0`, ctl.signal)).result,
}) as unknown as StageContext;

beforeAll(async () => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "img-")));
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
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  seen = [];
  steps = 0;
  sleeps = [];
  ctl = new AbortController();
  for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { recursive: true, force: true });
  handler = (_r, _b, res) => json(res, 500, {});
});
afterEach(() => undefined);

const geminiOk = (img: Buffer) => ({ steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: img.toString("base64") }] }] });
const openaiOk = (img: Buffer) => ({ data: [{ b64_json: img.toString("base64") }] });

const gemini = (price: typeof PRICE | null = PRICE) => createGeminiImage({ fetch: localFetch, getKey: async () => KEY, price, budgetScopes: [], readRef: async (id) => (id === "bad" ? HTML : PNG) });
const openai = (price: typeof PRICE | null = PRICE) => createOpenAIImage({ fetch: localFetch, getKey: async () => KEY, price, budgetScopes: [] });
const fal = (price: typeof FAL_PRICE | null = FAL_PRICE, extra: { fetchCdn?: SafeFetch } = {}) =>
  createFalImage({ fetch: localFetch, fetchCdn: extra.fetchCdn ?? localFetch, db: db.pool, getKey: async () => KEY, price, budgetScopes: [], sleep: async (ms) => { sleeps.push(ms); } });

const args = { prompt: "a red fox", aspect: "9:16" as const, model: "" };
const MODEL = { gemini: "gemini-3.1-flash-lite-image", openai: "gpt-image-1-mini", fal: "fal-ai/flux/schnell" };
const REQ_ID = "0a1b2c3d-1111-2222-3333-444455556666";

// A well-behaved fal server; `over` replaces single routes.
function falServer(over: { submit?: Handler; status?: Handler; result?: Handler; file?: Handler } = {}) {
  handler = (req, body, res) => {
    const u = req.url!;
    if (req.method === "POST" && u === "/fal-ai/flux/schnell") return (over.submit ?? ((_r, _b, s) => json(s, 200, { request_id: REQ_ID })))(req, body, res);
    if (u.endsWith("/status")) return (over.status ?? ((_r, _b, s) => json(s, 200, { status: "COMPLETED" })))(req, body, res);
    if (u.startsWith("/fal-ai/flux/requests/")) return (over.result ?? ((_r, _b, s) => json(s, 200, { images: [{ url: "https://v3.fal.media/files/a/out.png" }], seed: 7 })))(req, body, res);
    if (u.startsWith("/files/")) return (over.file ?? ((_r, _b, s) => { s.writeHead(200, { "content-type": "image/png" }); s.end(PNG); }))(req, body, res);
    json(res, 404, {});
  };
}

type Case = { name: string; mk: () => ImageProvider; model: string; serve: (h: Handler) => void; okBody: (img: Buffer) => Handler };
const cases: Case[] = [
  { name: "gemini", mk: () => gemini(), model: MODEL.gemini, serve: (h) => { handler = h; }, okBody: (img) => (_r, _b, res) => json(res, 200, geminiOk(img)) },
  { name: "openai", mk: () => openai(), model: MODEL.openai, serve: (h) => { handler = h; }, okBody: (img) => (_r, _b, res) => json(res, 200, openaiOk(img)) },
  { name: "fal", mk: () => fal(), model: MODEL.fal, serve: (h) => falServer({ submit: h }), okBody: () => (_r, _b, res) => json(res, 200, { request_id: REQ_ID }) },
];

describe.each(cases)("$name error matrix", (c) => {
  const run = () => c.mk().generate(ctxFor(), { ...args, model: c.model });
  const expectClass = async (cls: ErrorClass, plainUnknown: boolean) => {
    const e = await run().then(() => null, (x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(classifyError(e)).toBe(cls);
    if (plainUnknown) expect(e).not.toBeInstanceOf(KnownFailure);
    expect(String((e as Error).message)).not.toContain(KEY);
  };
  it.each([400, 401, 403, 422])("%i is rejected before work: permanent", async (st) => {
    c.serve((_r, _b, res) => json(res, st, { error: { message: "nope" } }));
    await expectClass("permanent", false);
    const e = await run().catch((x) => x);
    expect(e).toBeInstanceOf(NotProcessedError);
  });
  it("429 is transient", async () => {
    c.serve((_r, _b, res) => json(res, 429, {}));
    await expectClass("transient", false);
  });
  it.each([408, 500, 502, 503])("%i is unknown (plain error, parks)", async (st) => {
    c.serve((_r, _b, res) => json(res, st, {}));
    await expectClass("unknown", true);
  });
  it("socket lost after send is unknown", async () => {
    c.serve((r) => r.socket.destroy());
    await expectClass("unknown", true);
  });
  it("empty 200 body is unknown", async () => {
    c.serve((_r, _b, res) => { res.writeHead(200); res.end(); });
    await expectClass("unknown", true);
  });
  it("key is sent in a header, never in the URL, and the prompt never in the URL", async () => {
    c.serve(c.okBody(PNG));
    await run().catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.url).not.toContain(KEY);
      expect(decodeURIComponent(s.url)).not.toContain("red fox");
    }
  });
});

describe("gemini and openai bodies", () => {
  it("gemini: truncated body is unknown", async () => {
    handler = (_r, _b, res) => { res.writeHead(200, { "content-length": "5000" }); res.write("{"); setTimeout(() => res.destroy(), 20); };
    const e = await gemini().generate(ctxFor(), { ...args, model: MODEL.gemini }).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(e).not.toBeInstanceOf(KnownFailure);
  });
  it("gemini: a 200 with no image (safety refusal that may bill) is unknown, not free", async () => {
    handler = (_r, _b, res) => json(res, 200, { steps: [{ type: "model_output", content: [{ type: "text", text: "blocked" }] }] });
    const e = await gemini().generate(ctxFor(), { ...args, model: MODEL.gemini }).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(e).not.toBeInstanceOf(KnownFailure);
  });
  it("openai: moderation_blocked 400 may bill, so it is unknown", async () => {
    handler = (_r, _b, res) => json(res, 400, { error: { code: "moderation_blocked", message: "safety" } });
    const e = await openai().generate(ctxFor(), { ...args, model: MODEL.openai }).catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
    expect(e).not.toBeInstanceOf(KnownFailure);
  });
  it("gemini: sends key in x-goog-api-key, aspect, refs inline; sidecar lists asset ids", async () => {
    handler = (_r, _b, res) => json(res, 200, geminiOk(PNG));
    const art = await gemini().generate(ctxFor(), { ...args, model: MODEL.gemini, refs: ["asset1"] });
    const req = seen[0]!;
    expect(req.headers["x-goog-api-key"]).toBe(KEY);
    const body = JSON.parse(req.body);
    expect(body.model).toBe(MODEL.gemini);
    expect(body.input.some((p: { type: string }) => p.type === "image")).toBe(true);
    expect(art.provenance).toMatchObject({ provider: "gemini_image", priceMicroUsd: 33_600, quoted: true });
    const sidecar = JSON.parse(readFileSync(art.path.replace(/\.png$/, ".json"), "utf8"));
    expect(sidecar).toEqual({ prompt: "a red fox", model: MODEL.gemini, refs: ["asset1"], seed: null });
  });
  it("gemini: a ref that is not an image is refused before any request", async () => {
    await expect(gemini().generate(ctxFor(), { ...args, model: MODEL.gemini, refs: ["bad"] })).rejects.toBeInstanceOf(KnownFailure);
    expect(seen).toHaveLength(0);
  });
  it("openai: sends bearer key and a JSON prompt", async () => {
    handler = (_r, _b, res) => json(res, 200, openaiOk(PNG));
    await openai().generate(ctxFor(), { ...args, model: MODEL.openai });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(seen[0]!.body).prompt).toBe("a red fox");
  });
  it("download_html_or_svg_refused (inline image)", async () => {
    for (const bad of [HTML, SVG]) {
      handler = (_r, _b, res) => json(res, 200, openaiOk(bad));
      const e = await openai().generate(ctxFor(), { ...args, model: MODEL.openai }).catch((x) => x);
      expect(classifyError(e)).toBe("unknown");
      expect(readdirSync(dir)).toEqual([]);
    }
  });
});

describe("rules before reserve", () => {
  it("quote_uses_price_rule_or_refuses_unpriced", async () => {
    expect(gemini().quote({ aspect: "9:16", refs: 0, model: MODEL.gemini })).toBe(33_600);
    expect(fal().quote({ aspect: "1:1", refs: 0, model: MODEL.fal })).toBe(3000);
    for (const p of [gemini(null), openai(null), fal(null)]) {
      const model = p.capability.id === "gemini_image" ? MODEL.gemini : p.capability.id === "openai_image" ? MODEL.openai : MODEL.fal;
      expect(() => p.quote({ aspect: "9:16", refs: 0, model })).toThrow(KnownFailure);
      await expect(p.generate(ctxFor(), { ...args, model })).rejects.toBeInstanceOf(KnownFailure);
    }
    expect(seen).toHaveLength(0);
    const wrongUnit = createOpenAIImage({ fetch: localFetch, getKey: async () => KEY, price: { unit: "per_second", microUsd: 5 } as never, budgetScopes: [] });
    expect(() => wrongUnit.quote({ aspect: "9:16", refs: 0, model: MODEL.openai })).toThrow(KnownFailure);
  });
  it("prompt is cleaned and bounded before anything is reserved", async () => {
    const paidCalls: number[] = [];
    const ctx = ctxFor();
    const inner = ctx.paid;
    (ctx as { paid: unknown }).paid = (...a: unknown[]) => { paidCalls.push(1); return (inner as (...x: unknown[]) => unknown)(...a); };
    const g = gemini();
    for (const prompt of ["", "  \u0000\u0007 ", "x".repeat(1001)]) {
      await expect(g.generate(ctx, { ...args, prompt, model: MODEL.gemini })).rejects.toBeInstanceOf(KnownFailure);
    }
    expect(paidCalls).toHaveLength(0);
    handler = (_r, _b, res) => json(res, 200, geminiOk(PNG));
    await g.generate(ctx, { ...args, prompt: "a\u0000b fox", model: MODEL.gemini });
    expect(JSON.stringify(JSON.parse(seen[0]!.body).input)).toContain("ab fox");
    await g.generate(ctx, { ...args, prompt: "y".repeat(1000), model: MODEL.gemini });
  });
  it("unsupported model, aspect, seed and too many refs are refused", async () => {
    const g = gemini();
    await expect(g.generate(ctxFor(), { ...args, model: "evil/model" })).rejects.toBeInstanceOf(KnownFailure);
    await expect(g.generate(ctxFor(), { ...args, model: MODEL.gemini, seed: 1 })).rejects.toBeInstanceOf(KnownFailure);
    await expect(g.generate(ctxFor(), { ...args, model: MODEL.gemini, refs: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] })).rejects.toBeInstanceOf(KnownFailure);
    await expect(openai().generate(ctxFor(), { ...args, model: MODEL.openai, refs: ["a"] })).rejects.toBeInstanceOf(KnownFailure);
    expect(seen).toHaveLength(0);
  });
  it("provider_without_ref_support_refused_for_locked_character", () => {
    const all = { gemini_image: gemini(), openai_image: openai(), fal_image: fal() };
    expect(pickImageProvider(all, "gemini_image", { locked: true }).capability.refImages).toBe(true);
    expect(() => pickImageProvider(all, "openai_image", { locked: true })).toThrow(KnownFailure);
    expect(() => pickImageProvider(all, "fal_image", { locked: true })).toThrow(KnownFailure);
    expect(pickImageProvider(all, "fal_image", { locked: false })).toBe(all.fal_image);
    expect(() => pickImageProvider(all, "nope", { locked: false })).toThrow(KnownFailure);
  });
  it("an output over 25 MB or not png/jpeg/webp is refused and writes nothing", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)]);
    await expect(saveImage(ctxFor(), big, { provider: "x", model: "m", prompt: "p", refs: [], priceMicroUsd: 1 })).rejects.toThrow();
    await expect(saveImage(ctxFor(), Buffer.from("GIF89a....."), { provider: "x", model: "m", prompt: "p", refs: [], priceMicroUsd: 1 })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("fal async flow", () => {
  const gen = (p = fal(), ctx = ctxFor()) => p.generate(ctx, { ...args, model: MODEL.fal, seed: 7 });
  const jobs = async () => (await db.pool.query("select state, provider_job_id, provider from media_jobs")).rows;
  const count = (re: RegExp) => seen.filter((s) => re.test(s.method + " " + s.url)).length;

  it("submits, stores the job id, polls (never below 2 s), downloads without the key, finishes", async () => {
    let polls = 0;
    falServer({ status: (_r, _b, res) => json(res, 200, { status: ++polls < 3 ? "IN_PROGRESS" : "COMPLETED" }) });
    const art = await gen();
    expect(art.path.endsWith(".png")).toBe(true);
    expect(readFileSync(art.path).equals(PNG)).toBe(true);
    expect(path.basename(art.path)).not.toMatch(/fox/);
    expect(art.provenance).toMatchObject({ provider: "fal_image", priceMicroUsd: 3000, quoted: true });
    expect(await jobs()).toEqual([{ state: "done", provider_job_id: REQ_ID, provider: "fal_image" }]);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(2000);
    const submit = seen.find((s) => s.method === "POST")!;
    expect(submit.headers.authorization).toBe(`Key ${KEY}`);
    expect(JSON.parse(submit.body)).toMatchObject({ prompt: "a red fox", seed: 7 });
    const file = seen.find((s) => s.url.startsWith("/files/"))!;
    expect(file.headers.authorization).toBeUndefined();
    const sidecar = JSON.parse(readFileSync(art.path.replace(/\.png$/, ".json"), "utf8"));
    expect(sidecar).toEqual({ prompt: "a red fox", model: MODEL.fal, refs: [], seed: 7 });
  });

  it("resume_polls_stored_job_id_not_submit", async () => {
    const stageRun = uuidv7();
    falServer({ status: (_r, _b, res) => json(res, 503, {}) }); // dies while polling
    steps = 0;
    await expect(gen(fal(), ctxFor(stageRun))).rejects.toThrow();
    expect(await jobs()).toEqual([{ state: "submitted", provider_job_id: REQ_ID, provider: "fal_image" }]);
    expect(count(/^POST/)).toBe(1);
    falServer(); // restart: same stage run and step
    steps = 0;
    const art = await gen(fal(), ctxFor(stageRun));
    expect(count(/^POST/)).toBe(1); // never resubmitted
    expect(readFileSync(art.path).equals(PNG)).toBe(true);
    expect((await jobs())[0]!.state).toBe("done");
  });

  it("kill_between_submit_and_store_parks_for_decision_not_resubmit", async () => {
    const stageRun = uuidv7();
    await submitOnce(db.pool, { stageRunId: stageRun, step: 0 }, "fal_image", "image", 3000); // row written, id never stored
    falServer();
    steps = 0;
    const e = await gen(fal(), ctxFor(stageRun)).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e)).toBe("unknown");
    expect(seen).toHaveLength(0); // no submit, no poll
    expect((await jobs())[0]!.state).toBe("unknown");
  });

  it("a stored job of another provider is not reused", async () => {
    const stageRun = uuidv7();
    await submitOnce(db.pool, { stageRunId: stageRun, step: 0 }, "other_image", "image", 3000);
    falServer();
    steps = 0;
    await expect(gen(fal(), ctxFor(stageRun))).rejects.not.toBeInstanceOf(KnownFailure);
    expect(seen).toHaveLength(0);
  });

  it("a clear submit refusal marks the job failed_known", async () => {
    falServer({ submit: (_r, _b, res) => json(res, 422, {}) });
    await expect(gen()).rejects.toBeInstanceOf(NotProcessedError);
    expect((await jobs())[0]!.state).toBe("failed_known");
  });

  it("download_html_or_svg_refused", async () => {
    for (const bad of [HTML, SVG]) {
      await db.reset();
      falServer({ file: (_r, _b, res) => { res.writeHead(200, { "content-type": "image/png" }); res.end(bad); } });
      const e = await gen().catch((x) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(KnownFailure);
      expect(readdirSync(dir)).toEqual([]);
      expect((await jobs())[0]!.state).not.toBe("done");
    }
  });

  it("a download URL off the fal CDN list (or not https) is never fetched", async () => {
    for (const url of ["https://evil.example/x.png", "http://v3.fal.media/x.png", "https://v3.fal.media.evil.example/x.png", "https://u:p@v3.fal.media/x.png"]) {
      await db.reset();
      seen = [];
      falServer({ result: (_r, _b, res) => json(res, 200, { images: [{ url }] }) });
      await expect(gen()).rejects.not.toBeInstanceOf(KnownFailure);
      expect(seen.some((s) => s.url.startsWith("/x.png"))).toBe(false);
    }
  });

  it("a fal job that reports failure is unknown (it may have billed)", async () => {
    falServer({ status: (_r, _b, res) => json(res, 200, { status: "COMPLETED", error: "boom", error_type: "x" }) });
    const e = await gen().catch((x) => x);
    expect(classifyError(e)).toBe("unknown");
  });

  it("cancel_stops_polling_and_leaves_intent_pending", async () => {
    falServer({ status: (_r, _b, res) => json(res, 200, { status: "IN_PROGRESS" }) });
    const slow = createFalImage({ fetch: localFetch, fetchCdn: localFetch, db: db.pool, getKey: async () => KEY, price: FAL_PRICE, budgetScopes: [], sleep: async (_ms, signal) => { ctl.abort(new Error("cancelled")); if (signal?.aborted) throw signal.reason; } });
    await expect(gen(slow)).rejects.toThrow("cancelled");
    const polls = count(/status$/);
    expect(polls).toBe(1);
    expect(await jobs()).toEqual([{ state: "submitted", provider_job_id: REQ_ID, provider: "fal_image" }]); // not finished, not failed
  });

  it("sidecar_has_no_key", async () => {
    falServer();
    const art = await gen();
    for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f)).toString("latin1")).not.toContain(KEY);
    expect(Object.keys(JSON.parse(readFileSync(art.path.replace(/\.png$/, ".json"), "utf8"))).sort()).toEqual(["model", "prompt", "refs", "seed"]);
    expect(JSON.stringify(art)).not.toContain(KEY);
  });
});
