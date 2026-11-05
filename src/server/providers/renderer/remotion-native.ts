import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { redactLine } from "@/server/core/log-redact";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { ProbeResult } from "@/server/core/qa";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import type { Renderer } from "./index";
import { nativeCommand } from "./native-sandbox";
import type { NativeReadiness } from "./native-preflight";
import { collectOutput, parseProgress, realDir, scale3dProps } from "./remotion-container";
import { stageSceneModels } from "./scene3d-models";
import type { Catalog3d } from "@/shared/assets3d/catalog";

// SECURITY CONTROL (Phase 5d): renders the 3D scale and 3D scene compositions on THIS Mac (GPU, Remotion gl "angle"), outside the locked
// Docker container, because software GL in the container is about 4x too slow for a 60 s video. What runs is our own
// composition, a scene file validated before this point (props.json) and the fixed catalogue models: no model-written code,
// no downloaded code. The boundary is native-sandbox.ts (sandbox-exec: no network but loopback, writes only to this job's out
// and temp folders, reads only the kit, node_modules, the job's in folder and the Chrome shell, env -i). It refuses to run
// when the setting is off, when the preflight is not ready, or when sandbox-exec is missing: there is no unsandboxed path.
// One job folder set per attempt (in, out, tmp) under the attempt folder, removed afterwards. The wall-clock limit is the
// separate render.native_timeout_s; cancellation and the limit kill the whole process group (runChild). Concurrency 1, nice 10.

export const NATIVE_IMAGE = "native-mac-angle";
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
  /** Test hooks. */
  node?: string;
  homeDir?: string;
  maxVideoBytes?: number;
}

export function createNativeRenderer(deps: NativeRendererDeps): Renderer {
  return {
    async render(ctx: StageContext, a) {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
      if (!a.scale3d && !a.scene3d) throw new KnownFailure("The native renderer only renders 3D scale and 3D scene videos.");
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
      try {
        await Promise.all([inDir, outDir, tmpDir].map((d) => mkdir(d, { recursive: true, mode: 0o700 })));
        // The inputs: props.json, and for a 3D scene ONLY the catalogue models it names, copied into <inDir>/models. The sandbox
        // reads this folder and nothing else of the repo or the storage root, so the read allow-list is not widened for them.
        let props: unknown;
        if (a.scene3d) {
          const catalog = await deps.catalog?.().catch(() => undefined);
          if (!catalog) throw new KnownFailure("The 3D model catalogue could not be read (assets3d/manifest.json). Nothing was rendered.");
          props = { scene: await stageSceneModels(a.scene3d, catalog, deps.assetsDir ?? path.join(repoRoot, "assets3d", "files"), inDir) };
        } else props = scale3dProps(a);
        await writeFile(path.join(inDir, "props.json"), JSON.stringify(props), { mode: 0o600, flag: "wx" });
        const node = deps.node ?? process.execPath;
        const nodeReal = await realpath(node);
        const cmd = nativeCommand({
          repoRoot, kitDir, nodeModules: await realpath(path.join(repoRoot, "node_modules")).catch(() => path.join(repoRoot, "node_modules")), storageRoot: await realpath(deps.root), homeDir: await realpath(deps.homeDir ?? homedir()),
          inDir, outDir, tmpDir, nodePrefix: path.dirname(path.dirname(nodeReal)), chromeDir: ready.chromeDir,
          node: nodeReal, outFile: path.join(outDir, "out.mp4"), mode: a.scene3d ? "--scene3d" : "--scale3d",
        });
        const tail: string[] = [];
        const timeoutS = ctx.config.render.nativeTimeoutS;
        ctx.log("render: native 3D render on this Mac (sandboxed, no network)");
        const r = await deps.runChild({
          ...cmd, cwd: attemptDir, cwdRoot: attemptDir, envAllow: [], timeoutMs: timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES,
          signal: ctx.signal, stageRunId: ctx.claim.stageRunId,
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
        if (r.aborted) throw ctx.signal.reason ?? new Error("render aborted");
        if (r.timedOut) throw new KnownFailure(`The native render took longer than its ${Math.ceil(timeoutS / 60)} min limit and was stopped.`);
        if (r.truncated) throw new KnownFailure("The render printed too much output and was stopped.");
        if (r.code !== 0) throw new KnownFailure(`The native render failed (exit ${r.code ?? r.signal}). Last lines: ${tail.slice(-3).join(" | ")}`.slice(0, 600));
        const outPath = await collectOutput(deps, ctx, a, outDir, false);
        return { outPath, image: NATIVE_IMAGE };
      } finally {
        await cleanup();
      }
    },
  };
}
