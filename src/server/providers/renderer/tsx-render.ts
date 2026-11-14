import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isTsxStyleId } from "../../../../remotion/kit/tsxlib/styledata";
import { redactLine } from "@/server/core/log-redact";
import type { ProbeResult } from "@/server/core/qa";
import type { StageContext } from "@/server/core/stage-handler";
import { checkTsx, echo, isStaticName, TSX_META, tsxDuration } from "@/server/core/tsx-check";
import { checkPreflight, preflightFrames, reviewStillFrames, type RgbFrame } from "@/server/core/tsx-preflight";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { daemonLimits, RENDER_IMAGE, type HostLimits } from "@/server/render/runner";
import { ASSET_EXT, copyRegular, mountable, NAME_PREFIX, realDir, runRenderContainer } from "./remotion-container";
import { TSX_SANDBOX, tsxRenderPlan } from "./tsx-sandbox";

// SECURITY CONTROL (ADR 0009): renders ONE model-written Remotion TSX file. Fails closed at every step and returns a typed
// error (for slice 3's retry loop) instead of throwing; only a cancelled stage throws.
//  1. checkTsx again (defence in depth: the caller checked it too).
//  2. Type-check with the TypeScript API in a worker thread of this process (tsx-typecheck.mjs): only the allowed module
//     typings, no Node types, a timeout and a heap cap. Never in the container.
//  3. Stage a fresh per-job folder: video.tsx, props.json, meta.json (the length from the checked file) and public/ with
//     copies of exactly the named files. Mounted read-only at /in of the TSX sandbox (tsx-sandbox.ts: the kit's locks plus
//     tighter limits); render-entry.mjs bundles only that file (tsx-index.ts imports nothing of the kit).
//  4. Preflight: frames 0, middle and last as PNG stills under the SAME plan and timeout, copied out without following
//     symlinks, decoded in a child process (still-child.mjs) and checked (tsx-preflight.ts). The full render runs only
//     when they pass; the three stills are then kept as tsx-frame-*.png in the attempt folder.
//  5. The video is copied out size-capped and probed: 1080x1920, not empty, the length meta promised.
// Error text is capped, scrubbed of secrets, and never quotes more than 30 characters of the scene source.

const TYPECHECK_THREAD = new URL("../../render/tsx-typecheck.mjs", import.meta.url);
const STILL_CHILD = fileURLToPath(new URL("../../render/still-child.mjs", import.meta.url));
const TYPECHECK_TIMEOUT_MS = 60_000;
const TYPECHECK_HEAP_MB = 1024;
const MAX_PROPS_BYTES = 64 * 1024;
const MAX_ASSETS = 40;
const MAX_STILL_BYTES = 32 * 1024 * 1024;
const MAX_JPEG_BYTES = 400 * 1024; // a 540x960 review picture; anything bigger is dropped, not sent to a model
const MAX_MESSAGE = 600;
const MAX_PROBLEMS = 10;
const SIZE = { width: TSX_META.width, height: TSX_META.height };

export type TsxFailureKind = "check" | "typecheck" | "render" | "timeout" | "preflight" | "output" | "review" | "infra";
export interface TsxRenderFailure {
  kind: TsxFailureKind;
  /** One plain sentence, at most 600 characters, safe to show and to feed back to the model. */
  message: string;
  /** Details (checker/compiler/preflight problems, last render lines), each scrubbed; at most 10. */
  problems: string[];
}
/** `stills`: the three checked preview frames (first, middle, last) kept as tsx-frame-<first|middle|last>.png in the attempt folder, for the video page and QA. */
export type TsxRenderResult = { ok: true; outPath: string; image: string; stills: string[] } | { ok: false; error: TsxRenderFailure };

export interface TsxRenderInput {
  /** The model-written file. */
  source: string;
  /** Plain JSON props passed to the default export (at most 64 KB). */
  props?: Record<string, unknown>;
  /** staticFile() name -> absolute host path of the file to stage (copied, never mounted; no symlink followed). */
  assets?: Record<string, string>;
  /** Word times for the caption overlay (cleaned by tsxCaptionWords). Passed in meta.json, never to the scene. */
  captions?: { word: string; startS: number; endS: number }[];
  /** The video's style id (one of the ten picker ids; null or unknown = ai_studio). Passed in meta.json; picks the yt-kit look. */
  style?: string | null;
  /** A plain file name inside ctx.attemptDir. */
  outFile: string;
  /**
   * The frame review. When set, up to 8 stills are rendered (the three preflight frames plus `reviewAt`, frame numbers of the
   * beats' midpoints) instead of 3, and after the preflight passes this is called with a 540x960 JPEG of each (our own render
   * output). Returning problems stops here with a 'review' failure (no full render); null/empty goes on to the video.
   * A throw (budget refusal, unclear paid outcome) goes up untouched.
   */
  review?: (shots: ReviewShot[]) => Promise<string[] | null>;
  /** Engine preview (ADR 0015): draw ONLY these frames (1-8) and stop; no review, no preflight checks, no video. */
  stillsOnly?: readonly number[];
  /** Engine frame check: draw and check the preflight frames (first, middle, last) exactly as a full render does, then stop; no video. */
  preflightOnly?: boolean;
  reviewAt?: readonly number[];
}
export interface ReviewShot {
  frame: number;
  jpeg: Uint8Array;
}

export interface TsxRendererDeps {
  /** Absolute, symlink-free path of remotion/kit, mounted read-only. */
  kitDir: string;
  runChild(spec: ChildSpec): Promise<ChildResult>;
  probe(file: string, signal: AbortSignal): Promise<ProbeResult>;
  hostLimits?: () => Promise<HostLimits>;
  image?: () => Promise<{ ref: string; pinned: boolean }>;
  workerId?: string;
  sweepDelayMs?: number;
  /** Test hook. Default: typeCheckInThread. */
  typeCheck?: (source: string, timeoutMs: number) => Promise<{ ok: boolean; problems: string[] }>;
}

export interface TsxRenderer {
  renderTsx(ctx: StageContext, input: TsxRenderInput): Promise<TsxRenderResult>;
}

/** The tsx_author stage calls this (worker/handlers.ts wires it with the same child registry, image and kit as the scene-kit renderer). */
export function createTsxRenderer(deps: TsxRendererDeps): TsxRenderer {
  return { renderTsx: (ctx, input) => renderTsx(deps, ctx, input) };
}

/**
 * Text safe to return: secrets redacted, printable ASCII, quoted parts over 30 characters shortened, at most 300
 * characters, and a line that still repeats 31+ characters of the scene source is replaced as a whole.
 */
export function scrub(text: string, source: string): string {
  let t = redactLine(String(text)).replace(/(['"`])([^'"`\n]{31,})\1/g, (_m, q: string, body: string) => `${q}${echo(body)}${q}`);
  t = t.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
  for (let i = 0; i + 31 <= t.length; i++) {
    if (source.includes(t.slice(i, i + 31))) return "(a line that quoted the scene source was hidden)";
  }
  return t;
}

/** Runs tsx-typecheck.mjs in a worker thread; terminates it on timeout. Never throws. */
export function typeCheckInThread(source: string, timeoutMs: number): Promise<{ ok: boolean; problems: string[] }> {
  return new Promise((resolve) => {
    let settled = false;
    let w: Worker | undefined;
    const done = (r: { ok: boolean; problems: string[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void w?.terminate().catch(() => undefined);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, problems: [`The type-check took longer than ${Math.round(timeoutMs / 1000)} s.`] }), timeoutMs);
    try {
      w = new Worker(TYPECHECK_THREAD, {
        workerData: { kind: "tsx-typecheck", source },
        resourceLimits: { maxOldGenerationSizeMb: TYPECHECK_HEAP_MB },
        stdout: true,
        stderr: true,
      });
    } catch {
      return done({ ok: false, problems: ["The type-checker could not start."] });
    }
    w.once("message", (m: unknown) => {
      const r = m as { ok?: unknown; problems?: unknown };
      const valid = typeof r?.ok === "boolean" && Array.isArray(r.problems) && r.problems.every((p) => typeof p === "string");
      done(valid ? { ok: r.ok as boolean, problems: r.problems as string[] } : { ok: false, problems: ["The type-checker gave an unreadable answer."] });
    });
    w.once("error", () => done({ ok: false, problems: ["The type-checker failed on this file."] }));
    w.once("exit", () => done({ ok: false, problems: ["The type-checker stopped without an answer."] }));
  });
}

export async function renderTsx(deps: TsxRendererDeps, ctx: StageContext, input: TsxRenderInput): Promise<TsxRenderResult> {
  if (input.outFile === "" || input.outFile !== path.basename(input.outFile) || input.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
  const source = typeof input.source === "string" ? input.source : "";
  const failure = (kind: TsxFailureKind, message: string, problems: string[] = []): TsxRenderResult => ({
    ok: false,
    error: { kind, message: scrub(message, source).slice(0, MAX_MESSAGE), problems: problems.slice(0, MAX_PROBLEMS).map((p) => scrub(p, source)) },
  });
  const aborted = () => ctx.signal.reason ?? new Error("render aborted");

  // 1. Static check, again.
  const checked = checkTsx(input.source);
  if (!checked.ok) return failure("check", "The scene file did not pass the safety check.", checked.problems);
  const frames = tsxDuration(source);
  if (!frames) return failure("check", "The scene file has no usable meta.durationInFrames.");
  let propsJson: string;
  try {
    const p = input.props ?? {};
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new Error("not an object");
    propsJson = JSON.stringify(p);
  } catch {
    return failure("infra", "The scene props are not a plain JSON object.");
  }
  if (Buffer.byteLength(propsJson) > MAX_PROPS_BYTES) return failure("infra", "The scene props are bigger than 64 KB.");

  // 2. Type-check (worker thread, timeout).
  const typed = await (deps.typeCheck ?? typeCheckInThread)(source, TYPECHECK_TIMEOUT_MS).catch(() => ({ ok: false, problems: ["The type-check could not run."] }));
  if (ctx.signal.aborted) throw aborted();
  if (typed.ok !== true) return failure("typecheck", "The scene file has type errors.", typed.problems);

  if (input.stillsOnly) {
    const bad = input.stillsOnly.find((f) => !Number.isInteger(f) || f < 0 || f >= frames);
    if (input.stillsOnly.length < 1 || input.stillsOnly.length > 8 || bad !== undefined) return failure("check", bad !== undefined ? `Frame ${bad} is outside the video (0-${frames - 1}).` : "Ask for 1 to 8 frames.");
  }
  const stillList = input.stillsOnly ? [...new Set(input.stillsOnly)] : input.review ? reviewStillFrames(frames, input.reviewAt ?? []) : preflightFrames(frames);
  const inDir = mountable(path.join(ctx.attemptDir, "tsx-in"));
  const outDir = mountable(path.join(ctx.attemptDir, "tsx-out"));
  const stillsDir = path.join(ctx.attemptDir, "tsx-stills");
  const cleanup = () => Promise.all([inDir, outDir, stillsDir].map((d) => rm(d, { recursive: true, force: true }))).catch(() => undefined);
  await cleanup();
  try {
    // 3. Stage.
    let kitDir: string;
    const publicDir = path.join(inDir, "public");
    try {
      kitDir = mountable(deps.kitDir);
      await realDir(kitDir, "kit");
      await mkdir(publicDir, { recursive: true, mode: 0o755 });
      await chmod(inDir, 0o755);
      await chmod(publicDir, 0o755);
      await mkdir(outDir, { mode: 0o700 });
      await chmod(outDir, 0o777); // the container runs as uid 10001; this folder holds nothing else
      await mkdir(stillsDir, { mode: 0o700 });
      await writeFile(path.join(inDir, "video.tsx"), source, { mode: 0o644, flag: "wx" });
      await writeFile(path.join(inDir, "props.json"), propsJson, { mode: 0o644, flag: "wx" });
      await writeFile(path.join(inDir, "meta.json"), JSON.stringify({ durationInFrames: frames, stills: stillList, captions: (input.captions ?? []).slice(0, 1500), ...(isTsxStyleId(input.style) ? { style: input.style } : {}) }), { mode: 0o644, flag: "wx" });
    } catch (e) {
      return failure("infra", `The TSX render folders could not be prepared (${e instanceof Error ? e.message : "unknown"}).`);
    }
    const staged = await stagePublicAssets(publicDir, input.assets ?? {});
    if (staged) return failure("infra", staged);
    try {
      await realDir(inDir, "input");
      await realDir(outDir, "output");
    } catch (e) {
      return failure("infra", e instanceof Error ? e.message : "The render folders are not usable.");
    }

    // 4. Plan: the same sandbox for the stills and the video.
    const host = await (deps.hostLimits ?? daemonLimits)();
    const image = deps.image ? await deps.image() : { ref: RENDER_IMAGE, pinned: false };
    if (!image.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${image.ref}`);
    const runId = ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 36);
    const runOnce = async (mode: "stills" | "video"): Promise<TsxRenderResult | null> => {
      const name = `${NAME_PREFIX}${runId}-tsx-${randomBytes(4).toString("hex")}`;
      let plan;
      try {
        plan = tsxRenderPlan({ name, host, imageRef: image.ref, workerId: deps.workerId, inDir, outDir, kitDir, config: ctx.config.render, mode });
      } catch {
        return failure("infra", "The render settings are not usable for a TSX render.");
      }
      const { r, tail } = await runRenderContainer(deps, ctx, { name, args: plan.args, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes });
      if (r.aborted) throw aborted();
      const what = mode === "stills" ? "The preview render" : "The TSX render";
      if (r.timedOut) return failure("timeout", `${what} took longer than its ${Math.round(plan.timeoutMs / 1000)} s limit and was stopped.`);
      if (r.truncated) return failure("render", `${what} printed too much output and was stopped.`);
      const lines = tail.filter((l) => !/^\s*(>|\||\d+\s*\|)/.test(l)).slice(-4);
      if (r.code !== 0) return failure("render", `${what} failed (exit ${r.code ?? r.signal}).`, lines);
      return null;
    };

    // 5. Preflight stills.
    const stillsRun = await runOnce("stills");
    if (stillsRun) return stillsRun;
    if (input.stillsOnly) {
      const names: string[] = [];
      try {
        for (const f of stillList) {
          const name = `preview-${f}.png`;
          const dest = path.join(ctx.attemptDir, name);
          await rm(dest, { force: true });
          await copyRegular(path.join(outDir, `still-${f}.png`), dest, MAX_STILL_BYTES);
          names.push(name);
        }
      } catch {
        return failure("render", "The preview frames were not drawn.");
      }
      return { ok: true, outPath: "", image: image.ref, stills: names };
    }
    const stills: RgbFrame[] = [];
    const shots: ReviewShot[] = [];
    const problems: string[] = [];
    const base = new Set(preflightFrames(frames));
    for (const f of stillList) {
      const got = await readStill(deps, ctx, outDir, stillsDir, f, input.review !== undefined);
      if (typeof got === "string") {
        if (base.has(f)) problems.push(got); // a missing extra frame only thins the review
      } else {
        if (base.has(f)) stills.push(got.rgb);
        if (got.jpeg) shots.push({ frame: f, jpeg: got.jpeg });
      }
    }
    if (problems.length > 0) return failure("preflight", "The preview frames could not be read.", problems);
    const pre = checkPreflight(stills, SIZE);
    if (!pre.ok) return failure("preflight", "The preview frames show a problem.", pre.problems);
    if (input.review && shots.length > 0) {
      const found = await input.review(shots); // throws go up: a budget refusal or an unclear paid outcome is never swallowed here
      if (found && found.length > 0) return failure("review", "A reviewer looked at key frames of the render and found problems.", found);
    }
    const kept: string[] = [];
    try {
      const names = ["first", "middle", "last"];
      const fs = preflightFrames(frames);
      for (let i = 0; i < fs.length; i++) {
        const name = `tsx-frame-${i === fs.length - 1 && fs.length > 1 ? "last" : names[i]}.png`; // a one- or two-frame file keeps first and last
        const dest = path.join(ctx.attemptDir, name);
        await rm(dest, { force: true }); // an earlier attempt in this folder may have left one
        await copyRegular(path.join(stillsDir, `still-${fs[i]}.png`), dest, MAX_STILL_BYTES);
        kept.push(name);
      }
    } catch {
      return failure("infra", "The preview frames could not be saved.");
    }
    await rm(stillsDir, { recursive: true, force: true });
    await Promise.all(stillList.map((f) => rm(path.join(outDir, `still-${f}.png`), { force: true })));
    await rm(path.join(outDir, "out.mp4"), { force: true });

    if (input.preflightOnly) return { ok: true, outPath: "", image: image.ref, stills: kept };

    // 6. The video.
    const videoRun = await runOnce("video");
    if (videoRun) return videoRun;
    const outPath = path.join(ctx.attemptDir, input.outFile);
    await rm(outPath, { force: true });
    try {
      await copyRegular(path.join(outDir, "out.mp4"), outPath, TSX_SANDBOX.maxFileBytes);
    } catch (e) {
      return failure("output", e instanceof Error && /bigger than/.test(e.message) ? "The rendered video is too big." : "The render finished but made no video file.");
    }
    let p: ProbeResult;
    try {
      p = await deps.probe(outPath, ctx.signal);
    } catch {
      if (ctx.signal.aborted) throw aborted();
      return failure("output", "The rendered file is not a readable video.");
    }
    const wantS = frames / TSX_META.fps;
    if (p.width !== SIZE.width || p.height !== SIZE.height) return failure("output", `The render is ${p.width}x${p.height}, expected ${SIZE.width}x${SIZE.height}.`);
    if (!(p.durationS > 0)) return failure("output", "The rendered video is empty.");
    if (Math.abs(p.durationS - wantS) > 1) return failure("output", `The video is ${p.durationS.toFixed(1)} s but meta says ${wantS.toFixed(1)} s.`);
    return { ok: true, outPath, image: image.ref, stills: kept };
  } finally {
    await cleanup();
  }
}

/** Copies each staticFile() name's host file into publicDir (no symlink followed). Returns a problem sentence, or null when all are staged. */
export async function stagePublicAssets(publicDir: string, assets: Record<string, string>, exts: ReadonlySet<string> = ASSET_EXT): Promise<string | null> {
  const list = Object.entries(assets);
  if (list.length > MAX_ASSETS) return `A scene may use at most ${MAX_ASSETS} files.`;
  for (const [name, src] of list) {
    if (!isStaticName(name) || !exts.has(path.extname(name).toLowerCase()) || typeof src !== "string" || !path.isAbsolute(src)) {
      return `The scene file '${echo(name)}' has an unusable name or type.`;
    }
    const dest = path.join(publicDir, name);
    try {
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o755 });
      for (let d = path.dirname(dest); d.length > publicDir.length && d.startsWith(publicDir + path.sep); d = path.dirname(d)) await chmod(d, 0o755);
      await copyRegular(src, dest);
    } catch {
      return `The scene file '${echo(name)}' could not be staged.`;
    }
  }
  return null;
}

/** Copies still-<f>.png out of the container folder (no symlink, size-capped) and decodes it in a child. A string is a problem. */
async function readStill(deps: TsxRendererDeps, ctx: StageContext, outDir: string, stillsDir: string, f: number, wantJpeg: boolean): Promise<{ rgb: RgbFrame; jpeg?: Uint8Array } | string> {
  const png = path.join(stillsDir, `still-${f}.png`);
  const raw = path.join(stillsDir, `still-${f}.rgb`);
  const jpg = path.join(stillsDir, `still-${f}.jpg`);
  try {
    await copyRegular(path.join(outDir, `still-${f}.png`), png, MAX_STILL_BYTES);
  } catch {
    return `Frame ${f} was not rendered.`;
  }
  const lines: string[] = [];
  const r = await deps.runChild({
    command: process.execPath, args: [STILL_CHILD, png, raw, String(SIZE.width), String(SIZE.height), ...(wantJpeg ? [jpg] : [])], cwd: stillsDir, cwdRoot: stillsDir,
    envAllow: ["PATH"], timeoutMs: 30_000, maxOutputBytes: 4096, signal: ctx.signal, stageRunId: ctx.claim.stageRunId, onLine: (l) => { lines.push(l); },
  }).catch(() => null);
  if (r?.aborted) throw ctx.signal.reason ?? new Error("render aborted");
  let answer: { ok?: unknown; message?: unknown } = {};
  try {
    answer = JSON.parse(lines.at(-1) ?? "{}") as typeof answer;
  } catch {
    /* unreadable */
  }
  if (!r || r.code !== 0 || answer.ok !== true) return typeof answer.message === "string" ? `Frame ${f}: ${answer.message.slice(0, 120)}` : `Frame ${f} could not be decoded.`;
  const st = await lstat(raw).catch(() => null);
  if (!st?.isFile() || st.size !== SIZE.width * SIZE.height * 3) return `Frame ${f} could not be decoded.`;
  const rgb: RgbFrame = { frame: f, width: SIZE.width, height: SIZE.height, rgb: new Uint8Array(await readFile(raw)) };
  if (!wantJpeg) return { rgb };
  const js = await lstat(jpg).catch(() => null);
  return { rgb, ...(js?.isFile() && js.size > 0 && js.size <= MAX_JPEG_BYTES ? { jpeg: new Uint8Array(await readFile(jpg)) } : {}) };
}

/** Engine preview frames (ADR 0015): the same checks and locked container as renderTsx, only the asked frames, as PNG paths. */
export async function renderTsxStills(deps: TsxRendererDeps, ctx: StageContext, input: { source: string; frames: readonly number[]; style?: string | null }): Promise<{ ok: true; files: string[]; frameCount: number } | { ok: false; message: string; problems: string[] }> {
  const r = await renderTsx(deps, ctx, { source: input.source, stillsOnly: input.frames, style: input.style ?? null, outFile: "preview.mp4" });
  if (!r.ok) return { ok: false, message: r.error.message, problems: r.error.problems };
  return { ok: true, files: r.stills.map((n) => path.join(ctx.attemptDir, n)), frameCount: tsxDuration(input.source) ?? 0 };
}
