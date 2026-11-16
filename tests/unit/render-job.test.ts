import { describe, expect, it } from "vitest";
import { SETTINGS } from "@/server/core/settings-registry";
import { chunkArg, MAX_OUTPUT_BYTES, renderArgs, renderJobSchema, renderPlan, RENDER_KINDS, TSX_ENTRY, TSX_EXTRA_FLAGS, TSX_SANDBOX, tsxRenderPlan, type RenderJob } from "@/server/render/render-job";

// A job is the only thing the worker hands to whoever starts the container. renderPlan must give exactly the commands the five
// renderers built themselves before: these golden tests compare it with those builders (renderArgs, tsxRenderPlan) on the same inputs.
const IMAGE = "sha256:" + "a".repeat(64);
const HOST = { cpus: 4, memoryMb: 8192 };
const CONFIG = { timeoutS: 600, cpus: 2, memoryMb: 3000, pids: 512 };
const BIG = { timeoutS: 3600, cpus: 8, memoryMb: 8192, pids: 1024 };
const at = { host: HOST, imageRef: IMAGE, inDir: "/data/videos/v1/attempt-1/render-in", outDir: "/data/videos/v1/attempt-1/render-out" };
const job = (over: Partial<RenderJob> = {}): RenderJob => ({
  kind: "kit", name: "ytstudio-render-run1-abcd1234", inDir: "videos/v1/attempt-1/render-in", outDir: "videos/v1/attempt-1/render-out", worker: "w-1", config: CONFIG, ...over,
});
const base = { name: "ytstudio-render-run1-abcd1234", host: HOST, imageRef: IMAGE, workerId: "w-1", inDir: at.inDir, outDir: at.outDir };

describe("renderPlan matches the commands the renderers built before", () => {
  it("kit", () => {
    const p = renderPlan(job(), at);
    expect(p.args).toEqual(renderArgs({ ...base, limits: CONFIG }));
    expect(p.timeoutMs).toBe(600_000);
    expect(p.maxOutputBytes).toBe(MAX_OUTPUT_BYTES);
  });
  it("kit-landscape, whole video and as a muted chapter chunk", () => {
    expect(renderPlan(job({ kind: "kit-landscape" }), at).args).toEqual(renderArgs({ ...base, limits: CONFIG, entry: ["/in", "/out/out.mp4", "--landscape"] }));
    for (const chunk of [{ from: 0, to: "end" as const }, { from: 30, to: 90 }]) {
      expect(renderPlan(job({ kind: "kit-landscape", chunk }), at).args).toEqual(renderArgs({ ...base, limits: CONFIG, entry: ["/in", "/out/out.mp4", "--landscape", chunkArg(chunk), "--muted"] }));
    }
  });
  it("thumbnail: capped at 300 s and 256 KiB of output", () => {
    const p = renderPlan(job({ kind: "thumbnail", config: { ...CONFIG, timeoutS: 900 } }), at);
    expect(p.args).toEqual(renderArgs({ ...base, limits: { cpus: 2, memoryMb: 3000, pids: 512 }, entry: ["/in", "/out/out.png", "--thumbnail"] }));
    expect(p.timeoutMs).toBe(300_000);
    expect(p.maxOutputBytes).toBe(256 * 1024);
    expect(renderPlan(job({ kind: "thumbnail", config: { ...CONFIG, timeoutS: 120 } }), at).timeoutMs).toBe(120_000);
  });
  it.each([["tsx-stills", "stills"], ["tsx-video", "video"], ["om-stills", "om-stills"], ["om-video", "om-video"]] as const)("%s equals tsxRenderPlan(%s), clamps included", (kind, mode) => {
    for (const config of [CONFIG, BIG]) {
      const want = tsxRenderPlan({ ...base, config, mode });
      expect(renderPlan(job({ kind, config }), at)).toEqual({ args: want.args, timeoutMs: want.timeoutMs, maxOutputBytes: want.maxOutputBytes });
    }
    const clamped = renderPlan(job({ kind, config: BIG }), at).args;
    expect(clamped).toEqual(expect.arrayContaining(["--cpus", "2", "--pids-limit", "256", "--memory", "2048m"])); // the 2048 MiB TSX cap, below what the 8192 MiB host allows (90% = 7372)
  });
  it("clip: the engine limits are NOT clamped to the TSX caps; entry, extra flags and timeout as before", () => {
    const p = renderPlan(job({ kind: "clip", config: BIG }), at);
    expect(p.args).toEqual(renderArgs({ ...base, limits: { cpus: 8, memoryMb: 8192, pids: 1024 }, extra: TSX_EXTRA_FLAGS, entry: ["/in", "/out/out.mp4", "--clip"] }));
    expect(p.timeoutMs).toBe(3_600_000);
    expect(p.maxOutputBytes).toBe(TSX_SANDBOX.maxOutputBytes);
  });
  it("passes the dev kit override and the host-path rewrite through, only when the caller gives them", () => {
    const plain = renderPlan(job(), at).args;
    expect(plain.some((a) => a.includes("/opt/render/kit:ro"))).toBe(false);
    const dev = renderPlan(job(), { ...at, kitDir: "/repo/remotion/kit", hostPath: (p) => p.replace("/data", "/host") }).args;
    expect(dev).toContain("/repo/remotion/kit:/opt/render/kit:ro");
    expect(dev).toContain("/host/videos/v1/attempt-1/render-in:/in:ro");
  });
  it("covers every kind and nothing else", () => {
    expect([...RENDER_KINDS]).toEqual(["kit", "kit-landscape", "thumbnail", "tsx-stills", "tsx-video", "om-stills", "om-video", "clip"]);
    expect(Object.keys(TSX_ENTRY).sort()).toEqual(["om-stills", "om-video", "stills", "video"]);
  });
  it("refuses unusable engine settings the way tsxRenderPlan does", () => {
    expect(() => renderPlan(job({ kind: "tsx-video", config: { ...CONFIG, cpus: 0 } }), at)).toThrow("invalid render settings");
  });
});

describe("renderJobSchema", () => {
  const ok = (over: Record<string, unknown> = {}) => renderJobSchema.safeParse({ ...job(), ...over });
  it("accepts a normal job of every kind", () => {
    for (const kind of RENDER_KINDS) expect(ok({ kind }).success, kind).toBe(true);
  });
  it("name: needs the render prefix and a short safe tail", () => {
    for (const name of ["x", "ytstudio-render-", "ytstudio-render-a b", "ytstudio-render-" + "a".repeat(61), "evil-ytstudio-render-a", "ytstudio-render-a;rm"]) expect(ok({ name }).success, name).toBe(false);
    expect(ok({ name: "ytstudio-render-" + "a".repeat(60) }).success).toBe(true);
  });
  it.each([["../x"], ["/abs"], ["a/../../b"], ["a/./b"], ["a//b"], ["a/b/"], ["a\0b"], ["a:b"], ["a,b"], ["a\nb"], [""], ["a".repeat(201)], ["."], [".."]])("folder %j is refused", (p) => {
    expect(ok({ inDir: p }).success).toBe(false);
    expect(ok({ outDir: p }).success).toBe(false);
  });
  it("folder: a 200-character relative path is fine", () => {
    expect(ok({ inDir: "a".repeat(200) }).success).toBe(true);
  });
  it("limits: ceilings and non-numbers", () => {
    const c = (o: Record<string, number>) => ({ ...CONFIG, ...o });
    expect(ok({ config: c({ cpus: 65 }) }).success).toBe(false);
    expect(ok({ config: c({ memoryMb: 65537 }) }).success).toBe(false);
    expect(ok({ config: c({ pids: 4097 }) }).success).toBe(false);
    expect(ok({ config: c({ timeoutS: 7201 }) }).success).toBe(false);
    expect(ok({ config: c({ cpus: 0 }) }).success).toBe(false);
    expect(ok({ config: c({ cpus: Number.NaN }) }).success).toBe(false);
    expect(ok({ config: c({ cpus: 64, memoryMb: 65536, pids: 4096, timeoutS: 7200 }) }).success).toBe(true);
  });
  it("chunk: only for kit-landscape, whole numbers, to not before from", () => {
    expect(ok({ kind: "kit-landscape", chunk: { from: 0, to: "end" } }).success).toBe(true);
    expect(ok({ kind: "kit-landscape", chunk: { from: 5, to: 9 } }).success).toBe(true);
    expect(ok({ kind: "kit", chunk: { from: 0, to: "end" } }).success).toBe(false);
    expect(ok({ kind: "kit-landscape", chunk: { from: 9, to: 5 } }).success).toBe(false);
    expect(ok({ kind: "kit-landscape", chunk: { from: -1, to: 5 } }).success).toBe(false);
    expect(ok({ kind: "kit-landscape", chunk: { from: 1.5, to: 5 } }).success).toBe(false);
    expect(ok({ kind: "kit-landscape", chunk: { from: 0, to: 10_000_000 } }).success).toBe(false);
  });
  it("rejects unknown fields (no flags, image or mounts can ride along)", () => {
    for (const extra of [{ image: "evil" }, { args: ["--privileged"] }, { mounts: ["/:/host"] }, { kitDir: "/x" }, { extra: ["--net=host"] }]) expect(ok(extra).success, JSON.stringify(extra)).toBe(false);
  });
  it("worker label: same pattern as today", () => {
    expect(ok({ worker: "w-1.a_b" }).success).toBe(true);
    expect(ok({ worker: "w 1" }).success).toBe(false);
    expect(ok({ worker: "a".repeat(65) }).success).toBe(false);
  });
});

describe("the schema ceilings never reject what the settings page allows", () => {
  // The service refuses a job above its ceilings instead of clamping it, so every setting's own maximum must fit under them.
  it.each([["render.timeout_s", "timeoutS"], ["render.cpus", "cpus"], ["render.memory_mb", "memoryMb"], ["render.pids", "pids"]] as const)("%s", (key, field) => {
    const schema = SETTINGS[key].schema;
    let max = 1;
    while (schema.safeParse(max * 2).success) max *= 2; // the largest power of two it takes
    let hi = max * 2, lo = max;
    while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (schema.safeParse(mid).success) lo = mid; else hi = mid; }
    const config = { ...CONFIG, [field]: lo };
    expect(renderJobSchema.safeParse({ ...job(), config }).success, `${key} max ${lo}`).toBe(true);
  });
});
