import { describe, expect, it } from "vitest";
import type { StageContext } from "@/server/core/stage-handler";
import { createDockerRunner } from "@/server/providers/renderer/container-runner";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { renderPlan, type RenderRequest } from "@/server/render/render-job";

// The docker adapter is today's behaviour behind the ContainerRunner port: same arguments, same logging, same clean-up.
const IMAGE = "sha256:" + "b".repeat(64);
const HOST = { cpus: 2, memoryMb: 3000 };
const job: RenderRequest = {
  kind: "kit", name: "ytstudio-render-run1-abcd1234", inDir: "/data/videos/v1/attempt-1/render-in", outDir: "/data/videos/v1/attempt-1/render-out",
  worker: "w-1", config: { timeoutS: 600, cpus: 2, memoryMb: 3000, pids: 512 },
};
const done: ChildResult = { code: 0, signal: null, truncated: false, timedOut: false, aborted: false };

function setup(over: { image?: { ref: string; pinned: boolean }; result?: ChildResult; lines?: string[]; exec?: (a: string[]) => Promise<string> } = {}) {
  const specs: ChildSpec[] = [];
  const logs: string[] = [];
  const progress: number[] = [];
  const execCalls: string[][] = [];
  const ctx = {
    claim: { stageRunId: "run-1", fence: 1 }, attemptDir: "/data/videos/v1/attempt-1", signal: new AbortController().signal,
    log: (l: string) => logs.push(l), progress: (p: number) => progress.push(p),
  } as unknown as StageContext;
  const runner = createDockerRunner({
    sweepDelayMs: 1,
    hostLimits: async () => HOST,
    image: async () => over.image ?? { ref: IMAGE, pinned: true },
    runChild: async (spec) => {
      specs.push(spec);
      if (spec.args[0] === "run") for (const l of over.lines ?? []) spec.onLine?.(l);
      return spec.args[0] === "run" ? (over.result ?? done) : done;
    },
    exec: over.exec ?? (async (a) => { execCalls.push(a); return ""; }),
  });
  return { runner, ctx, specs, logs, progress, execCalls };
}

describe("dockerRunner.run", () => {
  it("runs exactly the arguments renderPlan gives for the request, in its folders, and reports the image used", async () => {
    const { runner, ctx, specs } = setup();
    const out = await runner.run(ctx, job);
    const run = specs.find((s) => s.args[0] === "run")!;
    const want = renderPlan(job, { host: HOST, imageRef: IMAGE, inDir: job.inDir, outDir: job.outDir });
    expect(run.command).toBe("docker");
    expect(run.args).toEqual(want.args);
    expect(run.timeoutMs).toBe(want.timeoutMs);
    expect(run.maxOutputBytes).toBe(want.maxOutputBytes);
    expect(run.envAllow).toEqual(["PATH"]);
    expect(out).toEqual({ r: { code: 0, signal: null, truncated: false, timedOut: false, aborted: false }, tail: [], image: IMAGE });
  });
  it("removes the container by name afterwards, as the renderers always did", async () => {
    const { runner, ctx, specs } = setup();
    await runner.run(ctx, job);
    expect(specs.filter((s) => s.args[0] === "rm").map((s) => s.args)).toContainEqual(["rm", "-f", job.name]);
  });
  it("feeds progress and the last output lines to the stage, unchanged", async () => {
    const { runner, ctx, logs, progress } = setup({ lines: ["PROGRESS 10", "PROGRESS 100", "something went wrong"] });
    const out = await runner.run(ctx, job);
    expect(progress).toEqual([10, 100]);
    expect(logs).toContain("render: 10%");
    expect(out.tail).toEqual(["something went wrong"]);
  });
  it("says so when the image is not pinned, and runs the tag", async () => {
    const { runner, ctx, logs, specs } = setup({ image: { ref: "ytstudio-render:dev", pinned: false } });
    await runner.run(ctx, job);
    expect(logs).toContain("render: image not pinned (could not resolve its id); running the tag ytstudio-render:dev");
    expect(specs.find((s) => s.args[0] === "run")!.args).toContain("ytstudio-render:dev");
  });
  it("passes the failure outcome through (timeout, flood, abort, exit code)", async () => {
    const { runner, ctx } = setup({ result: { code: null, signal: "SIGKILL", truncated: true, timedOut: true, aborted: false } });
    expect((await runner.run(ctx, job)).r).toEqual({ code: null, signal: "SIGKILL", truncated: true, timedOut: true, aborted: false });
  });
});

describe("dockerRunner.run: unsafe folders", () => {
  it("refuses a folder whose path could add mount options, before anything runs", async () => {
    const { runner, ctx, specs } = setup();
    for (const bad of ["/data/a:/etc", "/data/a,ro", "relative/dir"]) await expect(runner.run(ctx, { ...job, inDir: bad }), bad).rejects.toThrow("cannot be mounted safely");
    expect(specs).toHaveLength(0);
  });
});

describe("dockerRunner.info / list / remove", () => {
  it("info reports the daemon's limits, the image and the docker version", async () => {
    const { runner } = setup({ exec: async (a) => (a[0] === "info" ? "27.3.1\n" : "") });
    expect(await runner.info()).toEqual({ host: HOST, image: { ref: IMAGE, pinned: true }, dockerVersion: "27.3.1" });
  });
  it("info has a null version when docker does not answer", async () => {
    const { runner } = setup({ exec: async () => { throw new Error("no daemon"); } });
    expect((await runner.info()).dockerVersion).toBeNull();
  });
  it("list returns render containers with their worker label and skips malformed lines", async () => {
    const { runner } = setup({ exec: async () => "ytstudio-render-run1-aaaa w-1\nnot-a-render-name w-2\nytstudio-render-run2-bbbb bad label\nytstudio-render-run3-cccc unknown\n\n" });
    expect(await runner.list()).toEqual([{ name: "ytstudio-render-run1-aaaa", worker: "w-1" }, { name: "ytstudio-render-run3-cccc", worker: "unknown" }]);
  });
  it("list is empty when docker fails (a sweep must never throw)", async () => {
    const { runner } = setup({ exec: async () => { throw new Error("down"); } });
    expect(await runner.list()).toEqual([]);
  });
  it("remove runs docker rm -f for a render container and refuses any other name", async () => {
    const { runner, execCalls } = setup();
    await runner.remove("ytstudio-render-run1-aaaa");
    expect(execCalls).toEqual([["rm", "-f", "ytstudio-render-run1-aaaa"]]);
    for (const bad of ["postgres", "ytstudio-render-", "ytstudio-render-a b", "-f", "ytstudio-render-a;b"]) await expect(runner.remove(bad), bad).rejects.toThrow("not a render container");
    expect(execCalls).toHaveLength(1);
  });
});
