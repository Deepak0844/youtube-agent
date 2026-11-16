import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRunnerConfig } from "../../infra/render-runner/config";
import { createRunnerServer, type RunnerDeps } from "../../infra/render-runner/server";
import { renderPlan, type RenderJob } from "@/server/render/render-job";

// The service against a fake `docker`: who is let in, what is validated, what is run, and what is cleaned up.
const TOKEN = "t".repeat(32);
const IMAGE = "sha256:" + "c".repeat(64);
const HOST = { cpus: 2, memoryMb: 3000 };
const HOST_ROOT = "/host/data";
const job: RenderJob = {
  kind: "kit", name: "ytstudio-render-run1-abcd1234", inDir: "videos/v1/a1/render-in", outDir: "videos/v1/a1/render-out",
  worker: "w-1", config: { timeoutS: 600, cpus: 2, memoryMb: 3000, pids: 512 },
};
type ExecOpts = { onLine?(l: string): void; signal?: AbortSignal; timeoutMs: number; maxOutputBytes: number };
type ExecRes = { code: number | null; signal: string | null; timedOut: boolean; truncated: boolean };
const OK: ExecRes = { code: 0, signal: null, timedOut: false, truncated: false };

let tmp: string;
let server: Server;
let base: string;
let calls: Array<{ args: string[]; o: ExecOpts }>;
let removed: string[];
let listed: Array<{ name: string; worker: string }>;

async function start(over: Partial<RunnerDeps> & { exec?: (args: string[], o: ExecOpts) => Promise<ExecRes> } = {}) {
  const { exec: userExec, ...rest } = over;
  const exec = userExec ?? (async () => OK);
  server = createRunnerServer({
    token: TOKEN, root: path.join(tmp, "data"), hostRoot: HOST_ROOT,
    image: async () => ({ ref: IMAGE, pinned: true }), hostLimits: async () => HOST, dockerVersion: async () => "27.3.1",
    exec: async (args, o) => { calls.push({ args, o }); return exec(args, o); },
    listContainers: async () => listed, removeContainer: async (n) => { removed.push(n); },
    cleanupDelayMs: 5,
    ...rest,
  } as RunnerDeps);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const auth = { authorization: `Bearer ${TOKEN}` };
const post = (body: unknown, headers: Record<string, string> = auth, signal?: AbortSignal) =>
  fetch(`${base}/v1/render`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...(signal && { signal }) });
const events = async (res: Response) => (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const until = async (cond: () => boolean, ms = 2000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 10)); expect(cond()).toBe(true); };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "rrs-")));
  mkdirSync(path.join(tmp, "data/videos/v1/a1/render-in"), { recursive: true });
  mkdirSync(path.join(tmp, "data/videos/v1/a1/render-out"), { recursive: true });
  calls = []; removed = []; listed = [];
});
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server?.closeAllConnections?.();
  rmSync(tmp, { recursive: true, force: true });
});

describe("who may call", () => {
  it("401 without a token or with a wrong one, on every route, and nothing runs", async () => {
    await start();
    for (const h of [{} as Record<string, string>, { authorization: "Bearer nope" }, { authorization: `Basic ${TOKEN}` }]) {
      expect((await fetch(`${base}/v1/info`, { headers: h })).status).toBe(401);
      expect((await fetch(`${base}/v1/containers`, { headers: h })).status).toBe(401);
      expect((await post(job, h)).status).toBe(401);
      expect((await fetch(`${base}/v1/render/${job.name}`, { method: "DELETE", headers: h })).status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });
  it("an unauthorised huge body is never read or run: the answer is 401, or the connection is dropped while the client is still uploading", async () => {
    await start();
    const r = await post("x".repeat(1024 * 1024), {}).catch(() => null); // the service may close before the upload finishes
    if (r) expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
  it("unknown paths are 404 and wrong methods 405, after the token check", async () => {
    await start();
    expect((await fetch(`${base}/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/v1/render`, { headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/v1/info`, { method: "POST", headers: auth })).status).toBe(405);
  });
});

describe("what a job must be", () => {
  it("400 for a body that is not JSON, not a job, or too big", async () => {
    await start();
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ kind: "kit" })).status).toBe(400);
    expect((await post({ ...job, args: ["--privileged"] })).status).toBe(400);
    expect((await post({ ...job, image: "evil" })).status).toBe(400);
    expect((await post("a".repeat(9000))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it("400 with one fixed sentence for a folder that is not a real folder inside the data root", async () => {
    await start();
    for (const inDir of ["videos/v1/a1/missing", "videos/v1/a1/render-in/../../../../.."]) {
      const r = await post({ ...job, inDir });
      expect(r.status, inDir).toBe(400);
    }
    const r = await post({ ...job, inDir: "videos/v1/a1/missing" });
    expect(await r.json()).toEqual({ error: "render folder not allowed" });
    expect(calls).toHaveLength(0);
  });
});

describe("running a render", () => {
  it("streams the output lines then an end event; the command is exactly renderPlan with the host paths and the service's own image", async () => {
    await start({ exec: async (_a, o) => { o.onLine?.("PROGRESS 10"); o.onLine?.("PROGRESS 100"); return OK; } });
    const res = await post(job);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await events(res)).toEqual([{ t: "line", s: "PROGRESS 10" }, { t: "line", s: "PROGRESS 100" }, { t: "end", code: 0, signal: null, timedOut: false, truncated: false }]);
    const want = renderPlan(job, { host: HOST, imageRef: IMAGE, inDir: `${HOST_ROOT}/videos/v1/a1/render-in`, outDir: `${HOST_ROOT}/videos/v1/a1/render-out` });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(want.args);
    expect(calls[0]!.o.timeoutMs).toBe(want.timeoutMs);
    expect(calls[0]!.o.maxOutputBytes).toBe(want.maxOutputBytes);
  });
  it("removes the container by name afterwards, now and once more shortly after", async () => {
    await start();
    await events(await post(job));
    await until(() => removed.filter((n) => n === job.name).length >= 2);
  });
  it("reports a failed render, a timeout and a flood in the end event, and still cleans up", async () => {
    await start({ exec: async () => ({ code: null, signal: "SIGKILL", timedOut: true, truncated: true }) });
    const ev = await events(await post(job));
    expect(ev.at(-1)).toEqual({ t: "end", code: null, signal: "SIGKILL", timedOut: true, truncated: true });
    await until(() => removed.includes(job.name));
  });
  it("a client that goes away stops the render and removes the container (worker abort or crash)", async () => {
    let aborted = false;
    await start({ exec: (_a, o) => new Promise<ExecRes>((resolve) => { o.signal?.addEventListener("abort", () => { aborted = true; resolve({ code: null, signal: "SIGTERM", timedOut: false, truncated: false }); }); o.onLine?.("PROGRESS 1"); }) });
    const ac = new AbortController();
    const res = await post(job, auth, ac.signal);
    const reader = res.body!.getReader();
    await reader.read(); // the first line has arrived: the render is running
    ac.abort();
    await until(() => aborted);
    await until(() => removed.includes(job.name));
  });
  it("one render at a time: a second job waits for the first, and a waiting job whose client left never runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let peak = 0;
    await start({ exec: async () => { running++; peak = Math.max(peak, running); await gate; running--; return OK; } });
    const second = { ...job, name: "ytstudio-render-run2-bbbb" };
    const third = { ...job, name: "ytstudio-render-run3-cccc" };
    const a = post(job);
    await until(() => calls.length === 1);
    const b = post(second);
    const ac = new AbortController();
    const c = post(third, auth, ac.signal).catch(() => null);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1); // the others are queued
    ac.abort();
    await new Promise((r) => setTimeout(r, 100)); // let the service see the client leave
    release();
    expect((await events(await a)).at(-1)).toMatchObject({ t: "end", code: 0 });
    expect((await events(await b)).at(-1)).toMatchObject({ t: "end", code: 0 });
    await c;
    expect(peak).toBe(1);
    expect(calls.map((x) => x.args.at(x.args.indexOf("--name") + 1))).toEqual([job.name, second.name]); // the departed third never ran
  });
});

describe("folders are checked again when the job's turn comes", () => {
  it("a queued job whose folder became a symlink while it waited never runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await start({ exec: async () => { await gate; return OK; } });
    const second = { ...job, name: "ytstudio-render-run2-bbbb", inDir: "videos/v1/a2/render-in", outDir: "videos/v1/a2/render-out" };
    mkdirSync(path.join(tmp, "data/videos/v1/a2/render-in"), { recursive: true });
    mkdirSync(path.join(tmp, "data/videos/v1/a2/render-out"), { recursive: true });
    const a = post(job);
    await until(() => calls.length === 1);
    const b = post(second); // passes the first check and queues
    await new Promise((r) => setTimeout(r, 80));
    rmSync(path.join(tmp, "data/videos/v1/a2/render-in"), { recursive: true });
    symlinkSync("/etc", path.join(tmp, "data/videos/v1/a2/render-in"));
    release();
    await events(await a);
    const ev = await events(await b);
    expect(ev.at(-1)).toMatchObject({ t: "end", code: null, error: "The render service could not run the job." });
    expect(calls).toHaveLength(1); // the second never reached docker
  });
});

describe("info, list, remove", () => {
  it("GET /v1/info", async () => {
    await start();
    expect(await (await fetch(`${base}/v1/info`, { headers: auth })).json()).toEqual({ dockerVersion: "27.3.1", host: HOST, image: { ref: IMAGE, pinned: true }, ready: true });
  });
  it("GET /v1/info says not ready when docker does not answer", async () => {
    await start({ dockerVersion: async () => null });
    expect((await (await fetch(`${base}/v1/info`, { headers: auth })).json() as { ready: boolean }).ready).toBe(false);
  });
  it("GET /v1/containers lists render containers", async () => {
    listed = [{ name: "ytstudio-render-a-1111", worker: "w-1" }];
    await start();
    expect(await (await fetch(`${base}/v1/containers`, { headers: auth })).json()).toEqual(listed);
  });
  it("DELETE removes a listed render container, and only that: other names are refused, unknown ones are 404", async () => {
    listed = [{ name: "ytstudio-render-a-1111", worker: "w-1" }];
    await start();
    const del = (n: string) => fetch(`${base}/v1/render/${n}`, { method: "DELETE", headers: auth });
    expect((await del("ytstudio-render-a-1111")).status).toBe(204);
    expect(removed).toEqual(["ytstudio-render-a-1111"]);
    expect((await del("postgres")).status).toBe(400);
    expect((await del("ytstudio-render-zzzz")).status).toBe(404);
    expect((await del("..%2Fetc")).status).toBe(400);
    expect(removed).toEqual(["ytstudio-render-a-1111"]);
  });
});

describe("loadRunnerConfig refuses to start without what it needs", () => {
  const good = { RENDER_RUNNER_TOKEN: TOKEN, RENDER_IMAGE: "ytstudio-render:dev", HOST_STORAGE_ROOT: "/srv/data" };
  it("accepts a full environment, with defaults", () => {
    expect(loadRunnerConfig(good)).toEqual({ ok: true, config: { token: TOKEN, image: "ytstudio-render:dev", hostRoot: "/srv/data", root: "/data", port: 4100 } });
  });
  it.each([["RENDER_RUNNER_TOKEN"], ["RENDER_IMAGE"], ["HOST_STORAGE_ROOT"]])("refuses when %s is missing or empty", (key) => {
    for (const v of [undefined, "", "  "]) {
      const r = loadRunnerConfig({ ...good, [key]: v });
      expect(r.ok, `${key}=${JSON.stringify(v)}`).toBe(false);
      if (!r.ok) expect(r.error).toContain(key);
    }
  });
  it("refuses a short token or one with odd characters, a relative or unsafe host root, and a bad image reference", () => {
    for (const t of ["short", "has space in it 123456", "ünicode-token-1234567", "a/b/c-token-1234567"]) expect(loadRunnerConfig({ ...good, RENDER_RUNNER_TOKEN: t }).ok, t).toBe(false);
    for (const h of ["relative", "/srv/a:/etc", "/srv/a,ro"]) expect(loadRunnerConfig({ ...good, HOST_STORAGE_ROOT: h }).ok, h).toBe(false);
    for (const i of ["a b", "--rm", "x;y"]) expect(loadRunnerConfig({ ...good, RENDER_IMAGE: i }).ok, i).toBe(false);
  });
  it("PORT and STORAGE_ROOT can be set", () => {
    expect(loadRunnerConfig({ ...good, PORT: "4200", STORAGE_ROOT: "/mnt/data" })).toMatchObject({ ok: true, config: { port: 4200, root: "/mnt/data" } });
    expect(loadRunnerConfig({ ...good, PORT: "99999" }).ok).toBe(false);
  });
});
void vi;
