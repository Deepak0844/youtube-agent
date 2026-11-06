import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sha256Hex as sha256Text } from "@/server/core/content-hash";
import { redactLine } from "@/server/core/log-redact";
import { KnownFailure } from "@/server/core/paid-call";
import { MAX_STILLS, MAX_STILL_BYTES, pngProblem } from "@/server/core/scene3d-stills";
import type { StageContext } from "@/server/core/stage-handler";
import type { ProbeResult } from "@/server/core/qa";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { openRegular } from "@/worker/stages/attempt";
import type { Renderer, RenderArgs, Scene3dStillsArgs, Scene3dStillsRenderer } from "./index";
import { nativeCommand, type NativeCommandInput } from "./native-sandbox";
import type { NativeReadiness } from "./native-preflight";
import { collectOutput, copyRegular, parseProgress, realDir, scale3dProps } from "./remotion-container";
import { stageSceneCode, stageSceneModels, type StagedTypeCheck } from "./scene3d-models";
import { typeCheckScene3d } from "@/server/render/scene3d-typecheck";
import type { Catalog3d } from "@/shared/assets3d/catalog";
import type { Scene3d } from "@/shared/scene3d";

// SECURITY CONTROL (Phase 5d): renders the 3D scale and 3D scene compositions on THIS Mac (GPU, Remotion gl "angle"), outside the locked
// Docker container, because software GL in the container is about 4x too slow for a 60 s video. What runs is our own
// composition, a scene file validated before this point (props.json) and the fixed catalogue models: no model-written code,
// no downloaded code. The boundary is native-sandbox.ts (sandbox-exec: no network but loopback, writes only to this job's out
// and temp folders, reads only the kit, node_modules, the job's in folder and the Chrome shell, env -i). It refuses to run
// when the setting is off, when the preflight is not ready, or when sandbox-exec is missing: there is no unsandboxed path.
// One job folder set per attempt (in, out, tmp) under the attempt folder, removed afterwards. The wall-clock limit is the
// separate render.native_timeout_s; cancellation and the limit kill the whole process group (runChild). Concurrency 1, nice 10.
// The preview pictures of a 3D story (--scene3d-stills) use the very same job, profile and checks; they only draw a few frames and
// write PNG files into the out folder, which the host copies out with a size cap, a PNG check and a 540x960 check.

export const NATIVE_IMAGE = "native-mac-angle";
/** The job folders (in, out, temp) may hold at most this much; a render that writes more is killed (a hostile scene filling the disk). */
export const JOB_QUOTA_BYTES = 6 * 1024 * 1024 * 1024;
export const QUOTA_POLL_MS = 2000;

/** True when `dir` is `of` or one of its ancestors (so an allow-back for `dir` would reopen `of`). */
export function coversPath(dir: string, of: string): boolean {
  const rel = path.relative(dir, of);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
/** Refuses an allow-back folder that is, or contains, the home folder, the repo or the storage root (node installed under the home folder would reopen it all). */
export function allowBackProblem(dirs: Record<string, string>, protectedDirs: Record<string, string>): string | null {
  for (const [n, d] of Object.entries(dirs)) for (const [pn, pd] of Object.entries(protectedDirs)) {
    if (coversPath(d, pd)) return `The ${n} folder (${d}) contains your ${pn} folder, so the render sandbox could not keep it closed. Install node somewhere outside it (for example with Homebrew) and run the render again. Nothing was rendered.`;
  }
  return null;
}

/** Total size in bytes of the files under `dirs` (lstat, no symlink followed, no du process). Missing folders count 0. */
export async function dirsSize(dirs: readonly string[]): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else total += (await lstat(f).catch(() => null))?.size ?? 0;
    }
  };
  for (const d of dirs) await walk(d);
  return total;
}
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface NativeRendererDeps {
  /** Storage root: never readable by the render, only the job folders under the attempt folder are. */
  root: string;
  /** Absolute path of remotion/kit in the repo the worker runs from. */
  kitDir: string;
  runChild(spec: ChildSpec): Promise<ChildResult>;
  probe(file: string, signal: AbortSignal): Promise<ProbeResult>;
  /** checkNativeRenderReady bound to this repo. */
  preflight(): Promise<NativeReadiness>;
  /** The 3D model catalogue and the folder of its files (default <repo>/assets3d/files): scene3d videos only. */
  catalog?: () => Promise<Catalog3d>;
  assetsDir?: string;
  /** Test hooks for the disk quota: how big the job folders are, the cap and the poll interval. */
  dirSize?: (dirs: readonly string[]) => Promise<number>;
  quotaBytes?: number;
  quotaPollMs?: number;
  /** The in-process type-check run again on the staged scene (default: typeCheckScene3d; tests inject one). */
  typeCheck?: StagedTypeCheck;
  /** Test hooks. */
  node?: string;
  homeDir?: string;
  maxVideoBytes?: number;
}

interface Job {
  inDir: string;
  outDir: string;
  repoRoot: string;
}

/**
 * One sandboxed native job: checks the setting and the preflight, makes the in/out/tmp folders, lets `prepare` fill the in folder,
 * runs render-entry.mjs in the given mode, and hands the out folder to `collect` before everything is removed.
 */
async function runNativeJob<T>(
  deps: NativeRendererDeps,
  ctx: StageContext,
  job: { mode: NonNullable<NativeCommandInput["mode"]>; /** authored scenes: sha256 of scene.tsx */ expectSha?: string; /** the output path argument, given the out folder */ output: (outDir: string) => string; prepare(j: Job): Promise<void>; collect(j: Job): Promise<T> },
): Promise<T> {
  if (!ctx.config.render.native3d) throw new KnownFailure("Native 3D rendering is switched off in Settings. Nothing was rendered.");
  const ready = await deps.preflight();
  if (!ready.ready || ready.chromeDir === null) throw new KnownFailure(`Native 3D rendering is not available: ${ready.message} Nothing was rendered.`.slice(0, 600));

  const kitDir = await realpath(deps.kitDir).catch(() => deps.kitDir);
  await realDir(kitDir, "kit");
  const repoRoot = path.resolve(kitDir, "..", "..");
  const attemptDir = await realpath(ctx.attemptDir);
  const inDir = path.join(attemptDir, "native-in");
  const outDir = path.join(attemptDir, "native-out");
  const tmpDir = path.join(attemptDir, "native-tmp");
  const cleanup = () => Promise.all([inDir, outDir, tmpDir].map((d) => rm(d, { recursive: true, force: true }))).catch(() => undefined);
  await cleanup();
  let poll: ReturnType<typeof setInterval> | undefined;
  let removeOuter: (() => void) | undefined;
  try {
    await Promise.all([inDir, outDir, tmpDir].map((d) => mkdir(d, { recursive: true, mode: 0o700 })));
    await job.prepare({ inDir, outDir, repoRoot });
    const node = deps.node ?? process.execPath;
    const nodeReal = await realpath(node);
    const homeReal = await realpath(deps.homeDir ?? homedir());
    const bad = allowBackProblem(
      { "node install": path.dirname(path.dirname(nodeReal)), "Chrome": ready.chromeDir, "node_modules": await realpath(path.join(repoRoot, "node_modules")).catch(() => path.join(repoRoot, "node_modules")), "kit": kitDir },
      { home: homeReal, "app": repoRoot, "storage": await realpath(deps.root) },
    );
    if (bad) throw new KnownFailure(bad.slice(0, 600));
    const cmd = nativeCommand({
      repoRoot, kitDir, nodeModules: await realpath(path.join(repoRoot, "node_modules")).catch(() => path.join(repoRoot, "node_modules")), storageRoot: await realpath(deps.root), homeDir: await realpath(deps.homeDir ?? homedir()),
      inDir, outDir, tmpDir, nodePrefix: path.dirname(path.dirname(nodeReal)), chromeDir: ready.chromeDir,
      node: nodeReal, outFile: job.output(outDir), mode: job.mode, ...(job.expectSha ? { expectSha: job.expectSha } : {}),
    });
    const tail: string[] = [];
    const timeoutS = ctx.config.render.nativeTimeoutS;
    ctx.log("render: native 3D render on this Mac (sandboxed, no network)");
    // Disk quota: every few seconds the job folders are measured; over the cap, the whole process group is killed (through the abort signal).
    const quota = deps.quotaBytes ?? JOB_QUOTA_BYTES;
    const abort = new AbortController();
    const onOuter = () => abort.abort(ctx.signal.reason);
    if (ctx.signal.aborted) onOuter();
    else ctx.signal.addEventListener("abort", onOuter, { once: true });
    removeOuter = () => ctx.signal.removeEventListener("abort", onOuter);
    let overQuota = 0;
    poll = setInterval(() => {
      void (deps.dirSize ?? dirsSize)([inDir, outDir, tmpDir]).then((n) => {
        if (n > quota && overQuota === 0) {
          overQuota = n;
          abort.abort(new Error("quota"));
        }
      }).catch(() => {
        if (overQuota === 0) { overQuota = -1; abort.abort(new Error("quota")); } // a failed measurement is a kill: fail closed
      });
    }, deps.quotaPollMs ?? QUOTA_POLL_MS);
    const r = await deps.runChild({
      // cwd is the private temp folder, NOT the attempt folder: the attempt folder sits under the read-denied storage root, and
      // node's process.cwd() (uv_cwd) fails with EPERM there. The temp folder is an allowed subtree, so getcwd works.
      ...cmd, cwd: tmpDir, cwdRoot: attemptDir, envAllow: [], timeoutMs: timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: abort.signal, stageRunId: ctx.claim.stageRunId,
      onLine: (line) => {
        const p = parseProgress(line);
        if (p !== null) { ctx.progress?.(p); return ctx.log(`render: ${p}%`); }
        const clean = redactLine(line).slice(0, 300);
        if (!clean.trim()) return;
        ctx.log(`render: ${clean}`);
        tail.push(clean);
        if (tail.length > 8) tail.shift();
      },
    });
    clearInterval(poll);
    ctx.signal.removeEventListener("abort", onOuter);
    if (overQuota < 0) throw new KnownFailure("The render was stopped because the size of its working folders could not be measured. Nothing was rendered.");
    if (overQuota > 0) throw new KnownFailure(`The render wrote more than ${Math.round(quota / 1024 ** 3)} GB of files and was stopped. Nothing was rendered. (${Math.round(overQuota / 1024 ** 3 * 10) / 10} GB at the check.)`);
    if (r.aborted) throw ctx.signal.reason ?? new Error("render aborted");
    if (r.timedOut) throw new KnownFailure(`The native render took longer than its ${Math.ceil(timeoutS / 60)} min limit and was stopped.`);
    if (r.truncated) throw new KnownFailure("The render printed too much output and was stopped.");
    if (r.code !== 0) throw new KnownFailure(`The native render failed (exit ${r.code ?? r.signal}). Last lines: ${tail.slice(-3).join(" | ")}`.slice(0, 600));
    return await job.collect({ inDir, outDir, repoRoot });
  } finally {
    if (poll) clearInterval(poll);
    removeOuter?.();
    await cleanup();
  }
}

/** The scene with its catalogue models staged into <inDir>/models (only the ones it names, checked against the manifest). */
async function stagedScene(deps: NativeRendererDeps, scene: Scene3d, j: Job) {
  const catalog = await deps.catalog?.().catch(() => undefined);
  if (!catalog) throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json). Nothing was rendered.");
  return stageSceneModels(scene, catalog, deps.assetsDir ?? path.join(j.repoRoot, "assets3d", "files"), j.inDir);
}

/** An AI-written scene staged into <inDir>: scene.tsx, props.json and the catalogue models it names (see stageSceneCode: fingerprint and checker re-run). */
async function stagedSceneCode(deps: NativeRendererDeps, input: NonNullable<RenderArgs["scene3dCode"]>, j: Job) {
  const catalog = await deps.catalog?.().catch(() => undefined);
  if (!catalog) throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json). Nothing was rendered.");
  return stageSceneCode(input, catalog, deps.assetsDir ?? path.join(j.repoRoot, "assets3d", "files"), j.inDir, deps.typeCheck ?? typeCheckScene3d);
}

export function createNativeRenderer(deps: NativeRendererDeps): Renderer & Scene3dStillsRenderer {
  return {
    async render(ctx: StageContext, a) {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
      if (!a.scale3d && !a.scene3d && !a.scene3dCode) throw new KnownFailure("The native renderer only renders 3D scale and 3D scene videos.");
      return runNativeJob(deps, ctx, {
        mode: a.scene3dCode ? "--scene3d-code" : a.scene3d ? "--scene3d" : "--scale3d",
        ...(a.scene3dCode ? { expectSha: sha256Text(a.scene3dCode.source) } : {}),
        output: (outDir) => path.join(outDir, "out.mp4"),
        // The inputs: props.json, and for a 3D scene ONLY the catalogue models it names, copied into <inDir>/models. The sandbox
        // reads this folder and nothing else of the repo or the storage root, so the read allow-list is not widened for them.
        prepare: async (j) => {
          if (a.scene3dCode) return stagedSceneCode(deps, a.scene3dCode, j); // refuses a changed or unsafe scene BEFORE anything is written
          const props = a.scene3d ? { scene: await stagedScene(deps, a.scene3d, j) } : scale3dProps(a);
          await writeFile(path.join(j.inDir, "props.json"), JSON.stringify(props), { mode: 0o600, flag: "wx" });
        },
        collect: async (j) => ({ outPath: await collectOutput(deps, ctx, a, j.outDir, false), image: NATIVE_IMAGE }),
      });
    },

    /** Draws the given frames of a 3D scene as 540x960 PNGs and copies them into <attemptDir>/stills/NN.png (at most 8, each checked). */
    async stills(ctx: StageContext, a: Scene3dStillsArgs) {
      if (a.frames.length < 1 || a.frames.length > MAX_STILLS || !a.frames.every((f) => Number.isInteger(f) && f >= 0)) throw new Error("stills: 1 to 8 whole frame numbers are needed");
      if (!a.scene3d === !a.scene3dCode) throw new Error("stills: give exactly one of scene3d and scene3dCode");
      const dest = path.join(await realpath(ctx.attemptDir), "stills");
      return runNativeJob(deps, ctx, {
        mode: a.scene3dCode ? "--scene3d-code-stills" : "--scene3d-stills",
        ...(a.scene3dCode ? { expectSha: sha256Text(a.scene3dCode.source) } : {}),
        output: (outDir) => outDir,
        prepare: async (j) => {
          if (a.scene3dCode) await stagedSceneCode(deps, a.scene3dCode, j);
          else await writeFile(path.join(j.inDir, "props.json"), JSON.stringify({ scene: await stagedScene(deps, a.scene3d!, j) }), { mode: 0o600, flag: "wx" });
          await writeFile(path.join(j.inDir, "stills.json"), JSON.stringify({ frames: a.frames }), { mode: 0o600, flag: "wx" });
        },
        collect: async (j) => {
          await rm(dest, { recursive: true, force: true });
          await mkdir(dest, { recursive: true, mode: 0o700 });
          const files: string[] = [];
          for (let i = 1; i <= a.frames.length; i++) {
            const name = String(i).padStart(2, "0");
            const to = path.join(dest, `${name}.png`);
            await copyRegular(path.join(j.outDir, `still-${name}.png`), to, MAX_STILL_BYTES).catch(() => {
              throw new KnownFailure(`Preview picture ${i} was not drawn, or is bigger than ${MAX_STILL_BYTES / 1024 / 1024} MB. Nothing was saved.`);
            });
            const fh = await openRegular(to);
            const head = Buffer.alloc(24);
            try {
              await fh.read(head, 0, 24, 0);
            } finally {
              await fh.close();
            }
            const bad = pngProblem(head);
            if (bad) throw new KnownFailure(`Preview picture ${i} ${bad}. Nothing was saved.`);
            files.push(`stills/${name}.png`);
          }
          return { files, image: NATIVE_IMAGE };
        },
      });
    },
  };
}
