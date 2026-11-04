import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { redactLine } from "@/server/core/log-redact";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { assetRefs } from "@/server/core/scene-build";
import type { ProbeResult } from "@/server/core/qa";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { assertRealDir, daemonLimits, JOB_LABEL, lockFlags, RENDER_IMAGE, type HostLimits } from "@/server/render/runner";
import { safeJoin } from "@/server/storage/paths";
import { buildVideoProps } from "@/shared/scene/video-props";
import { isCaptionStyleId, isStyleId } from "../../../../remotion/kit/presets";
import { openRegular } from "@/worker/stages/attempt";
import type { Renderer } from "./index";

// SECURITY CONTROL: the production renderer. The scene document is model-written, so the render runs in the render image
// under ADR 0003's locks (lockFlags in runner.ts, shared with the Phase 0 runner): no network, read-only root, noexec /tmp,
// every capability dropped, no-new-privileges, uid 10001, pids/memory/cpu limits (settings, clamped to the daemon), a hard
// wall-clock limit, no environment at all (the docker CLI itself gets only PATH through runChild), and the image by its
// sha256 id when the worker could resolve it. It sees exactly three mounts, each an existing symlink-free directory:
//   /in  (ro)  a fresh staging folder: props.json, the narration copy, and copies of ONLY the asset files the doc names;
//   /out (rw)  a fresh empty folder inside this attempt folder;
//   /opt/render/kit (ro)  the scene kit code.
// The storage root, the repo and the docker socket are never mounted. The container has a unique name and label and is
// force-removed whatever happens, by name and again by label (now and ~1 s later, for a create that raced the first
// remove); the worker also sweeps leftovers at boot. The output is read back without following symlinks or blocking on a
// FIFO, size-capped, and probed. The wall-clock limit is what bounds how much the container can write to /out.
// Cleanup: /out is 0777 with no sticky bit, so the worker can delete the files uid 10001 writes there. A subdirectory the
// container made inside /out could not be emptied by the worker on Linux; it stays in the attempt folder for the sweep.

export const ASSET_EXT: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp", ".mp4"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac"]);
const ASSET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // same rule as the scene schema
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const MOUNT_SAFE = /^[^:,\0\r\n]+$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
const FPS = 30; // keep equal to remotion/kit/theme.ts
export const NAME_PREFIX = "ytstudio-render-";
const WORKER_LABEL = "ytstudio.worker";
const WORKER_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ContainerRendererDeps {
  /** Storage root: asset files are copied from here (never mounted). */
  root: string;
  /** Absolute, symlink-free path of remotion/kit, mounted read-only. */
  kitDir: string;
  /** storageRef (relative to root) of an asset's main file, or null when there is no such asset. */
  assetFile(id: string): Promise<string | null>;
  /** runChild bound to the worker's child registry. */
  runChild(spec: ChildSpec): Promise<ChildResult>;
  probe(file: string, signal: AbortSignal): Promise<ProbeResult>;
  hostLimits?: () => Promise<HostLimits>;
  /** The image to run: its sha256 id when resolved at boot (pinned), else the tag. Default: the tag, unpinned. */
  image?: () => Promise<{ ref: string; pinned: boolean }>;
  /** This worker's id, put on every container as ytstudio.worker so the boot sweep spares a live worker's renders. */
  workerId?: string;
  /** Test hooks. */
  sweepDelayMs?: number;
  maxVideoBytes?: number;
}

/** "PROGRESS <0-100>" from render-entry.mjs, else null. */
export function parseProgress(line: string): number | null {
  const m = /^PROGRESS (\d{1,3})$/.exec(line);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : null;
}

const run = promisify(execFile);
const dockerEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }) as unknown as NodeJS.ProcessEnv; // PATH only: no DOCKER_HOST/CONFIG, no secrets

/** Image id of the render image (`docker image inspect`), resolved once at worker boot. Falls back to the tag. Never throws. */
export async function resolveRenderImage(image = RENDER_IMAGE): Promise<{ ref: string; pinned: boolean }> {
  try {
    const { stdout } = await run("docker", ["image", "inspect", "-f", "{{.Id}}", image], { env: dockerEnv(), timeout: 15_000 });
    const id = stdout.trim();
    if (/^sha256:[0-9a-f]{64}$/.test(id)) return { ref: id, pinned: true };
  } catch {
    /* fall through */
  }
  return { ref: image, pinned: false };
}

/**
 * Boot: removes render containers whose worker is dead (its Postgres advisory lock is free, see child-processes.ts). A live
 * worker's containers (a sibling on the same daemon) are never touched; a liveness check that fails counts as alive.
 * Best effort, never throws.
 */
export async function sweepRenderContainers(deps: {
  isAlive(workerId: string): Promise<boolean>;
  exec?: (args: string[]) => Promise<string>;
}): Promise<number> {
  const exec = deps.exec ?? (async (args: string[]) => (await run("docker", args, { env: dockerEnv(), timeout: 30_000 })).stdout);
  try {
    const out = await exec(["ps", "-a", "--filter", `label=${JOB_LABEL}`, "--filter", `label=${WORKER_LABEL}`, "--filter", `name=${NAME_PREFIX}`, "--format", `{{.ID}} {{.Label "${WORKER_LABEL}"}}`]);
    const byWorker = new Map<string, string[]>();
    for (const line of out.split("\n")) {
      const [id, worker] = line.trim().split(" ");
      if (!id || !CONTAINER_ID.test(id) || !worker || !WORKER_ID.test(worker)) continue;
      byWorker.set(worker, [...(byWorker.get(worker) ?? []), id]);
    }
    const dead: string[] = [];
    for (const [worker, ids] of byWorker) {
      if (!(await deps.isAlive(worker).catch(() => true))) dead.push(...ids);
    }
    if (dead.length > 0) await exec(["rm", "-f", ...dead]);
    return dead.length;
  } catch {
    return 0;
  }
}

export interface RenderArgsInput {
  name: string;
  limits: { cpus: number; memoryMb: number; pids: number };
  host: HostLimits;
  imageRef: string;
  workerId?: string;
  /** Mount sources: absolute, already checked with mountable() and realDir(). */
  inDir: string;
  outDir: string;
  kitDir: string;
  /** Extra hardening flags placed after the shared locks; only ever adds limits (see tsx-sandbox.ts). */
  extra?: readonly string[];
  /** Arguments of render-entry.mjs (after the image). Default: the kit render, /in /out/out.mp4. */
  entry?: readonly string[];
}

/** The `docker run` argument list of one render. Builds only; runs nothing. */
export function renderArgs(o: RenderArgsInput): string[] {
  return [
    "run", "--rm", "--name", o.name,
    ...lockFlags(o.limits, o.host),
    ...(o.extra ?? []),
    "--log-driver", "none",
    "--label", `${JOB_LABEL}=${o.name}`,
    "--label", `${WORKER_LABEL}=${o.workerId && WORKER_ID.test(o.workerId) ? o.workerId : "unknown"}`,
    "-v", `${o.inDir}:/in:ro`,
    "-v", `${o.outDir}:/out:rw`,
    "-v", `${o.kitDir}:/opt/render/kit:ro`,
    "-w", "/tmp",
    "--entrypoint", "node",
    o.imageRef,
    "/opt/render/kit/render-entry.mjs", ...(o.entry ?? ["/in", "/out/out.mp4"]),
  ];
}

export function mountable(p: string): string {
  if (!path.isAbsolute(p) || path.normalize(p) !== p || !MOUNT_SAFE.test(p)) throw new KnownFailure("A render folder has a path that cannot be mounted safely.");
  return p;
}

export async function realDir(p: string, what: string): Promise<void> {
  try {
    await assertRealDir(p, what);
  } catch (e) {
    throw new KnownFailure(`The render ${what} folder is missing or not a plain folder (${(e as Error).message}).`);
  }
}

/**
 * Copies a regular file (no symlink followed, no FIFO opened blocking) to dest, readable by the container user. Reads at most
 * maxBytes + 1 bytes, so a file still growing cannot push the copy past the cap; a bigger file is refused and the partial copy removed.
 */
export async function copyRegular(src: string, dest: string, maxBytes = MAX_VIDEO_BYTES): Promise<void> {
  const st = await lstat(src).catch(() => null);
  if (!st?.isFile()) throw new KnownFailure(`The file ${path.basename(src)} is missing or not a plain file.`);
  let fh;
  try {
    fh = await openRegular(src);
  } catch {
    throw new KnownFailure(`The file ${path.basename(src)} is missing or not a plain file.`);
  }
  let n = 0;
  const tooBig = () => new KnownFailure(`The file ${path.basename(src)} is bigger than ${maxBytes} bytes.`);
  try {
    if ((await fh.stat()).size > maxBytes) throw tooBig();
    const stream = fh.createReadStream({ autoClose: false, end: maxBytes }); // end is inclusive: at most maxBytes + 1 bytes
    await writeFile(dest, (async function* () {
      for await (const chunk of stream) {
        n += (chunk as Buffer).length;
        if (n > maxBytes) throw tooBig();
        yield chunk as Buffer;
      }
    })(), { mode: 0o644, flag: "wx" });
  } catch (e) {
    if (n > 0) await rm(dest, { force: true });
    throw e;
  } finally {
    await fh.close();
  }
}

/**
 * Runs one `docker run` (args from renderArgs) and always removes the container afterwards. PROGRESS lines go to
 * ctx.progress; other lines are redacted, logged and the last 8 kept in `tail`.
 */
export async function runRenderContainer(
  deps: Pick<ContainerRendererDeps, "runChild" | "sweepDelayMs">,
  ctx: StageContext,
  o: { name: string; args: string[]; timeoutMs: number; maxOutputBytes: number },
): Promise<{ r: ChildResult; tail: string[] }> {
  const docker = (dargs: string[], onLine?: (l: string) => void) =>
    deps.runChild({
      command: "docker", args: dargs, cwd: ctx.attemptDir, envAllow: ["PATH"], timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
      signal: new AbortController().signal, stageRunId: ctx.claim.stageRunId, onLine,
    }).catch(() => undefined);
  const sweepByLabel = async () => {
    const ids: string[] = [];
    await docker(["ps", "-aq", "--filter", `label=${JOB_LABEL}=${o.name}`], (l) => { if (CONTAINER_ID.test(l.trim())) ids.push(l.trim()); });
    if (ids.length > 0) await docker(["rm", "-f", ...ids]);
  };

  const tail: string[] = [];
  let r: ChildResult;
  try {
    r = await deps.runChild({
      command: "docker", args: o.args, cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, envAllow: ["PATH"],
      timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes, signal: ctx.signal, stageRunId: ctx.claim.stageRunId,
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
  } finally {
    // Killing the docker CLI does not stop the container: remove it by name, then by label now and once more shortly
    // after (the daemon may still create it after the CLI died). Each call has its own signal, never the stage's.
    await docker(["rm", "-f", o.name]);
    await sweepByLabel();
    setTimeout(() => void sweepByLabel(), deps.sweepDelayMs ?? 1000).unref();
  }
  return { r, tail };
}

export function createContainerRenderer(deps: ContainerRendererDeps): Renderer {
  return {
    async render(ctx: StageContext, a) {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
      if (!a.doc && !a.scale3d) throw new KnownFailure("The render step needs the checked scenes. Run the build step again.");
      const inDir = mountable(path.join(ctx.attemptDir, "render-in"));
      const outDir = mountable(path.join(ctx.attemptDir, "render-out"));
      const kitDir = mountable(deps.kitDir);
      await realDir(kitDir, "kit");
      const name = `${NAME_PREFIX}${ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 36)}-${randomBytes(4).toString("hex")}`;
      const cleanup = () => Promise.all([rm(inDir, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true })]).catch(() => undefined);
      await cleanup();
      try {
        await mkdir(path.join(inDir, "assets"), { recursive: true, mode: 0o755 });
        await mkdir(outDir, { mode: 0o700 });
        await chmod(inDir, 0o755);
        await chmod(path.join(inDir, "assets"), 0o755);
        await chmod(outDir, 0o777); // the container runs as uid 10001; this folder holds nothing else

        // Stage: only the asset ids the doc names, each from the storage root, plain files of an allowed type.
        const assets: Record<string, string> = {};
        for (const id of a.doc ? [...new Set(assetRefs(a.doc))] : []) {
          if (!ASSET_ID.test(id)) throw new KnownFailure("The scenes name an asset with an unusable id.");
          const ref = await deps.assetFile(id);
          if (!ref) throw new KnownFailure(`The scenes use asset '${id}', which no longer exists. Run the build step again.`);
          const ext = path.extname(ref).toLowerCase();
          if (!ASSET_EXT.has(ext)) throw new KnownFailure(`Asset '${id}' has a file type the renderer does not take.`);
          let src: string;
          try {
            src = await safeJoin(deps.root, ref);
          } catch {
            throw new KnownFailure(`Asset '${id}' could not be read.`);
          }
          await copyRegular(src, path.join(inDir, "assets", `${id}${ext}`));
          assets[id] = `assets/${id}${ext}`;
        }
        let audioSrc: string | undefined;
        if (a.audioFile && !a.scale3d) { // the 3D composition has no sound of its own: the voice step lays the narration over it
          const ext = path.extname(a.audioFile).toLowerCase();
          if (!AUDIO_EXT.has(ext)) throw new KnownFailure("The narration has a file type the renderer does not take.");
          audioSrc = `narration${ext}`;
          await copyRegular(a.audioFile, path.join(inDir, audioSrc));
        }
        let props: { ok: true; props: unknown } | { ok: false; errors: string[] };
        if (a.scale3d) {
          const caps = (a.captions ?? [])
            .filter((w): w is { word: string; startS: number; endS: number } => typeof (w as { word?: unknown })?.word === "string" && Number.isFinite((w as { startS?: unknown }).startS) && Number.isFinite((w as { endS?: unknown }).endS))
            .map((w) => ({ word: w.word.slice(0, 60), startS: w.startS, endS: w.endS }));
          props = { ok: true, props: { scene: a.scale3d, ...(caps.length ? { captions: caps } : {}), ...(isStyleId(a.style) ? { style: a.style } : {}), ...(isCaptionStyleId(a.captionStyle) ? { captionStyle: a.captionStyle } : {}) } };
        } else props = buildVideoProps(JSON.stringify(a.doc), { fps: FPS, audioSrc, assets, captionsText: a.captions ? JSON.stringify(a.captions) : undefined, seed: a.videoId, title: a.title, style: a.style, captionStyle: a.captionStyle });
        if (!props.ok) throw new KnownFailure(`The scenes or captions are not valid: ${props.errors.slice(0, 3).join("; ")}`.slice(0, 600));
        await writeFile(path.join(inDir, "props.json"), JSON.stringify(props.props), { mode: 0o644, flag: "wx" });
        await realDir(inDir, "input");
        await realDir(outDir, "output");

        const lim = ctx.config.render;
        const host = await (deps.hostLimits ?? daemonLimits)();
        const image = deps.image ? await deps.image() : { ref: RENDER_IMAGE, pinned: false };
        if (!image.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${image.ref}`);
        const args = renderArgs({ name, limits: lim, host, imageRef: image.ref, workerId: deps.workerId, inDir, outDir, kitDir, ...(a.scale3d ? { entry: ["/in", "/out/out.mp4", "--scale3d"] } : {}) });
        const { r, tail } = await runRenderContainer(deps, ctx, { name, args, timeoutMs: lim.timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES });
        if (r.aborted) throw ctx.signal.reason ?? new Error("render aborted");
        if (r.timedOut) throw new KnownFailure(`The render took longer than its ${Math.ceil(lim.timeoutS / 60)} min limit and was stopped.`);
        if (r.truncated) throw new KnownFailure("The render printed too much output and was stopped.");
        if (r.code !== 0) throw new KnownFailure(`The render failed (exit ${r.code ?? r.signal}). Last lines: ${tail.slice(-3).join(" | ")}`.slice(0, 600));

        const outPath = path.join(ctx.attemptDir, a.outFile);
        await rm(outPath, { force: true });
        await copyRegular(path.join(outDir, "out.mp4"), outPath, deps.maxVideoBytes ?? MAX_VIDEO_BYTES).catch((e: unknown) => {
          throw new KnownFailure(e instanceof Error && /bigger than/.test(e.message) ? "The rendered video is too big." : "The render finished but made no video file.");
        });
        let p: ProbeResult;
        try {
          p = await deps.probe(outPath, ctx.signal);
        } catch {
          throw new KnownFailure("The rendered file is not a readable video.");
        }
        if (p.width !== a.size.width || p.height !== a.size.height) throw new KnownFailure(`The render is ${p.width}x${p.height}, expected ${a.size.width}x${a.size.height}.`);
        if (!(p.durationS > 0)) throw new KnownFailure("The rendered video is empty.");
        if (audioSrc && !p.hasAudio) throw new KnownFailure("The rendered video has no sound although narration was given.");
        const docS = a.scale3d ? a.scale3d.beats.reduce((t, b) => t + b.duration_s, 0) : Math.max(...a.doc!.scenes.map((s) => s.startMs + s.durationMs)) / 1000;
        if (Math.abs(p.durationS - docS) > 1) ctx.log(`render: warning: the video is ${p.durationS.toFixed(1)} s but the scenes add up to ${docS.toFixed(1)} s`);
        return { outPath, image: image.ref };
      } finally {
        await cleanup();
      }
    },
  };
}
