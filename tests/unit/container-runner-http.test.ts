import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunnerServer, type ExecOpts, type ExecResult, type RunnerDeps } from "../../infra/render-runner/server";
import { NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createHttpRunner } from "@/server/providers/renderer/container-runner";
import { renderPlan, type RenderRequest } from "@/server/render/render-job";

// The worker's client against the real service (in process) with a fake docker: the same results the docker adapter gives.
const TOKEN = "t".repeat(32);
const IMAGE = "sha256:" + "d".repeat(64);
const HOST = { cpus: 2, memoryMb: 3000 };
const HOST_ROOT = "/host/data";
const OK: ExecResult = { code: 0, signal: null, timedOut: false, truncated: false };

let tmp: string;
let root: string;
let server: Server | undefined;
let url: string;
let execs: string[][];
let removed: string[];

const req = (over: Partial<RenderRequest> = {}): RenderRequest => ({
  kind: "kit", name: "ytstudio-render-run1-abcd1234", inDir: path.join(root, "videos/v1/a1/render-in"), outDir: path.join(root, "videos/v1/a1/render-out"),
  worker: "w-1", config: { timeoutS: 600, cpus: 2, memoryMb: 3000, pids: 512 }, ...over,
});
function ctxOf(signal = new AbortController().signal) {
  const logs: string[] = [];
  const progress: number[] = [];
  const ctx = { claim: { stageRunId: "run-1", fence: 1 }, attemptDir: root, signal, log: (l: string) => logs.push(l), progress: (p: number) => progress.push(p) } as unknown as StageContext;
  return { ctx, logs, progress };
}
async function start(exec: (a: string[], o: ExecOpts) => Promise<ExecResult> = async () => OK, over: Partial<RunnerDeps> = {}) {
  server = createRunnerServer({
    token: TOKEN, root, hostRoot: HOST_ROOT, image: async () => ({ ref: IMAGE, pinned: true }), hostLimits: async () => HOST, dockerVersion: async () => "27.3.1",
    exec: async (a, o) => { execs.push(a); return exec(a, o); },
    listContainers: async () => [{ name: "ytstudio-render-a-1111", worker: "w-1" }], removeContainer: async (n) => { removed.push(n); }, cleanupDelayMs: 5, ...over,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const runner = (over: { url?: string; token?: string; margin?: number } = {}) => createHttpRunner({ url: over.url ?? url, token: over.token ?? TOKEN, storageRoot: root, requestTimeoutMarginMs: over.margin ?? 5000 });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "hr-")));
  root = path.join(tmp, "data");
  mkdirSync(path.join(root, "videos/v1/a1/render-in"), { recursive: true });
  mkdirSync(path.join(root, "videos/v1/a1/render-out"), { recursive: true });
  execs = []; removed = []; server = undefined;
});
afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  rmSync(tmp, { recursive: true, force: true });
});

describe("httpRunner.run", () => {
  it("runs the job through the service: the command is renderPlan on the host paths, and the result has the docker adapter's shape", async () => {
    await start();
    const { ctx } = ctxOf();
    const out = await runner().run(ctx, req());
    expect(out).toEqual({ r: { code: 0, signal: null, timedOut: false, truncated: false, aborted: false }, tail: [], image: IMAGE });
    const job = { ...req(), inDir: undefined, outDir: undefined }; // renderPlan takes the folders from `at`
    expect(execs[0]).toEqual(renderPlan(job, { host: HOST, imageRef: IMAGE, inDir: `${HOST_ROOT}/videos/v1/a1/render-in`, outDir: `${HOST_ROOT}/videos/v1/a1/render-out` }).args);
  });
  it("feeds progress and the last output lines to the stage, as the docker adapter does", async () => {
    await start(async (_a, o) => { for (const l of ["PROGRESS 10", "PROGRESS 100", "something went wrong"]) o.onLine?.(l); return OK; });
    const { ctx, logs, progress } = ctxOf();
    const out = await runner().run(ctx, req());
    expect(progress).toEqual([10, 100]);
    expect(logs).toContain("render: 10%");
    expect(out.tail).toEqual(["something went wrong"]);
  });
  it("clips long output lines before they reach the stage log or the tail", async () => {
    await start(async (_a, o) => { o.onLine?.("word ".repeat(400)); return OK; });
    const { ctx, logs } = ctxOf();
    const out = await runner().run(ctx, req());
    expect(out.tail[0]!.length).toBeLessThanOrEqual(300);
    expect(logs.some((l) => l.startsWith("render: word"))).toBe(true);
  });
  it("says so when the image is not pinned", async () => {
    await start(undefined, { image: async () => ({ ref: "ytstudio-render:dev", pinned: false }) });
    const { ctx, logs } = ctxOf();
    expect((await runner().run(ctx, req())).image).toBe("ytstudio-render:dev");
    expect(logs).toContain("render: image not pinned (could not resolve its id); running the tag ytstudio-render:dev");
  });
  it("passes a failed render, a timeout and a flood through", async () => {
    await start(async () => ({ code: null, signal: "SIGKILL", timedOut: true, truncated: true }));
    const { ctx } = ctxOf();
    expect((await runner().run(ctx, req())).r).toEqual({ code: null, signal: "SIGKILL", timedOut: true, truncated: true, aborted: false });
  });
  it("aborting the stage aborts the render, removes the container, and reports aborted", async () => {
    let sawAbort = false;
    await start((_a, o) => new Promise<ExecResult>((resolve) => { o.onLine?.("PROGRESS 1"); o.signal?.addEventListener("abort", () => { sawAbort = true; resolve({ code: null, signal: "SIGTERM", timedOut: false, truncated: false }); }); }));
    const ac = new AbortController();
    const { ctx, progress } = ctxOf(ac.signal);
    const p = runner().run(ctx, req());
    while (progress.length === 0) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect((await p).r.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(sawAbort).toBe(true);
    expect(removed).toContain(req().name);
  });
  it("a render that outlasts its limit (plus the margin) is stopped and reported as timed out", async () => {
    await start((_a, o) => new Promise<ExecResult>((resolve) => o.signal?.addEventListener("abort", () => resolve({ code: null, signal: "SIGTERM", timedOut: false, truncated: false }))));
    const { ctx } = ctxOf();
    const t = Date.now();
    const out = await runner({ margin: 50 }).run(ctx, req({ config: { timeoutS: 1, cpus: 2, memoryMb: 3000, pids: 512 } }));
    expect(out.r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 100));
    expect(removed).toContain(req().name);
  });
});

describe("httpRunner.run: when the service is not there or says no", () => {
  it("a refused connection is a plain 'not reachable' error at once, not a hang", async () => {
    const dead = await new Promise<number>((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; s.close(() => r(port)); }); });
    const { ctx } = ctxOf();
    const t = Date.now();
    const e = await runner({ url: `http://127.0.0.1:${dead}` }).run(ctx, req()).catch((x) => x);
    expect(e).toBeInstanceOf(NotProcessedError);
    expect((e as Error).message).toBe("The render service is not reachable.");
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it("a job the service refuses is 'refused the job' (a permanent failure, not a retry)", async () => {
    await start();
    const { ctx } = ctxOf();
    const e = await runner().run(ctx, req({ name: "not-a-render-name" })).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect((e as Error).message).toBe("The render service refused the job.");
    expect(execs).toHaveLength(0);
  });
  it("a wrong token is 'refused' (a setting to fix), and neither token appears in the message", async () => {
    await start();
    const { ctx } = ctxOf();
    const e = await runner({ token: "w".repeat(32) }).run(ctx, req()).catch((x) => x);
    expect(e).toBeInstanceOf(KnownFailure);
    expect((e as Error).message).toBe("The render service refused the request.");
    expect(JSON.stringify(e instanceof Error ? e.message : e)).not.toContain(TOKEN);
    expect(execs).toHaveLength(0);
  });
  it("a folder outside the storage root is refused before any request", async () => {
    await start();
    const { ctx } = ctxOf();
    for (const inDir of ["/etc", path.join(tmp, "data2/x"), "relative", `${root}/../x`]) {
      await expect(runner().run(ctx, req({ inDir })), inDir).rejects.toThrow("cannot be sent to the render service");
    }
    expect(execs).toHaveLength(0);
  });
  it("a service that dies mid-render (no end event) is a 'stopped answering' error, not a success", async () => {
    const half = http.createServer((q, r) => { if (q.url === "/v1/info") { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ dockerVersion: "x", host: HOST, image: { ref: IMAGE, pinned: true }, ready: true })); return; } r.writeHead(200); r.write('{"t":"line","s":"PROGRESS 5"}\n'); setTimeout(() => r.destroy(), 20); });
    await new Promise<void>((r) => half.listen(0, "127.0.0.1", r));
    const { ctx } = ctxOf();
    const e = await createHttpRunner({ url: `http://127.0.0.1:${(half.address() as AddressInfo).port}`, token: TOKEN, storageRoot: root }).run(ctx, req()).catch((x) => x);
    half.closeAllConnections();
    half.close();
    expect(e).toBeInstanceOf(NotProcessedError);
    expect((e as Error).message).toBe("The render service stopped answering.");
  });
});

describe("httpRunner.info / list / remove", () => {
  it("round-trips them", async () => {
    await start();
    const r = runner();
    expect(await r.info()).toEqual({ host: HOST, image: { ref: IMAGE, pinned: true }, dockerVersion: "27.3.1" });
    expect(await r.list()).toEqual([{ name: "ytstudio-render-a-1111", worker: "w-1" }]);
    await r.remove("ytstudio-render-a-1111");
    expect(removed).toEqual(["ytstudio-render-a-1111"]);
    await expect(r.remove("postgres")).rejects.toThrow("not a render container");
  });
  it("list is empty and info reports no docker when the service is down (a clean-up or a status page must never throw)", async () => {
    const dead = await new Promise<number>((r) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as AddressInfo).port; s.close(() => r(port)); }); });
    const r = runner({ url: `http://127.0.0.1:${dead}` });
    expect(await r.list()).toEqual([]);
    expect((await r.info().catch(() => null))?.dockerVersion ?? null).toBeNull();
  });
});
