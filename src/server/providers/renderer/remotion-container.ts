import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactLine } from "@/server/core/log-redact";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { assetRefs } from "@/server/core/scene-build";
import type { ProbeResult } from "@/server/core/qa";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { daemonLimits, RENDER_IMAGE, type HostLimits } from "@/server/render/runner";
import { safeJoin } from "@/server/storage/paths";
import { buildVideoProps } from "@/shared/scene/video-props";
import { openRegular } from "@/worker/stages/attempt";
import type { Renderer } from "./index";

// SECURITY CONTROL: the production renderer. The scene document is model-written, so the render runs in the pinned render
// image under ADR 0003's locks: no network, read-only root, every capability dropped, no-new-privileges, uid 10001,
// pids/memory/cpu limits (settings, clamped to the daemon), a hard wall-clock limit, and no environment at all (the docker
// CLI itself gets only PATH through runChild). It sees exactly three mounts:
//   /in  (ro)  a fresh staging folder: props.json, the narration copy, and copies of ONLY the asset files the doc names;
//   /out (rw)  a fresh empty folder inside this attempt folder;
//   /opt/render/kit (ro)  the scene kit code.
// The storage root, the repo and the docker socket are never mounted. The container has a unique name and is force-removed
// whatever happens (done, failed, timed out, cancelled). The output is read back without following symlinks and probed.

const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const AUDIO_EXT = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac"]);
const ASSET_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/; // same rule as the scene schema
const MOUNT_SAFE = /^[^:,\0\r\n]+$/;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const FPS = 30; // keep equal to remotion/kit/theme.ts
const RENDER_USER = "10001:10001"; // the image's `render` user (infra/Dockerfile.render)

export interface ContainerRendererDeps {
  /** Storage root: asset files are copied from here (never mounted). */
  root: string;
  /** Absolute path of remotion/kit, mounted read-only. */
  kitDir: string;
  /** storageRef (relative to root) of an asset's main file, or null when there is no such asset. */
  assetFile(id: string): Promise<string | null>;
  /** runChild bound to the worker's child registry. */
  runChild(spec: ChildSpec): Promise<ChildResult>;
  probe(file: string, signal: AbortSignal): Promise<ProbeResult>;
  hostLimits?: () => Promise<HostLimits>;
  image?: string;
}

/** "PROGRESS <0-100>" from render-entry.mjs, else null. */
export function parseProgress(line: string): number | null {
  const m = /^PROGRESS (\d{1,3})$/.exec(line);
  const n = m ? Number(m[1]) : NaN;
  return n >= 0 && n <= 100 ? n : null;
}

function mountable(p: string): string {
  if (!path.isAbsolute(p) || path.normalize(p) !== p || !MOUNT_SAFE.test(p)) throw new KnownFailure("A render folder has a path that cannot be mounted safely.");
  return p;
}

/** Copies a regular file (no symlink followed) to dest, readable by the container user. */
async function copyRegular(src: string, dest: string): Promise<void> {
  let fh;
  try {
    fh = await openRegular(src);
  } catch {
    throw new KnownFailure(`The file ${path.basename(src)} is missing or not a plain file.`);
  }
  try {
    await writeFile(dest, fh.createReadStream({ autoClose: false }), { mode: 0o644, flag: "wx" });
  } finally {
    await fh.close();
  }
}

export function createContainerRenderer(deps: ContainerRendererDeps): Renderer {
  return {
    async render(ctx: StageContext, a) {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".")) throw new Error("outFile must be a plain file name");
      if (!a.doc) throw new KnownFailure("The render step needs the checked scenes. Run the build step again.");
      const inDir = mountable(path.join(ctx.attemptDir, "render-in"));
      const outDir = mountable(path.join(ctx.attemptDir, "render-out"));
      const kitDir = mountable(deps.kitDir);
      const name = `ytstudio-render-${ctx.claim.stageRunId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64)}-${randomBytes(4).toString("hex")}`;
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
        for (const id of [...new Set(assetRefs(a.doc))]) {
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
        if (a.audioFile) {
          const ext = path.extname(a.audioFile).toLowerCase();
          if (!AUDIO_EXT.has(ext)) throw new KnownFailure("The narration has a file type the renderer does not take.");
          audioSrc = `narration${ext}`;
          await copyRegular(a.audioFile, path.join(inDir, audioSrc));
        }
        const props = buildVideoProps(JSON.stringify(a.doc), { fps: FPS, audioSrc, assets, captionsText: a.captions ? JSON.stringify(a.captions) : undefined });
        if (!props.ok) throw new KnownFailure(`The scenes or captions are not valid: ${props.errors.slice(0, 3).join("; ")}`.slice(0, 600));
        await writeFile(path.join(inDir, "props.json"), JSON.stringify(props.props), { mode: 0o644, flag: "wx" });

        const lim = ctx.config.render;
        const host = await (deps.hostLimits ?? daemonLimits)();
        const cpus = Math.min(lim.cpus, host.cpus);
        const memoryMb = Math.min(lim.memoryMb, Math.floor(host.memoryMb * 0.9));
        const args = [
          "run", "--rm", "--name", name, "--pull=never",
          "--network", "none",
          "--read-only",
          "--tmpfs", "/tmp:rw,size=1g,mode=1777", // HOME/TMPDIR, the webpack bundle, Chrome's profile
          "--shm-size=256m",
          "--user", RENDER_USER,
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", String(lim.pids),
          "--memory", `${memoryMb}m`,
          "--memory-swap", `${memoryMb}m`,
          "--cpus", String(cpus),
          "--log-driver", "none",
          "--label", `ytstudio.job=${name}`,
          "-v", `${inDir}:/in:ro`,
          "-v", `${outDir}:/out:rw`,
          "-v", `${kitDir}:/opt/render/kit:ro`,
          "-w", "/tmp",
          "--entrypoint", "node",
          deps.image ?? RENDER_IMAGE,
          "/opt/render/kit/render-entry.mjs", "/in", "/out/out.mp4",
        ];

        const tail: string[] = [];
        let r: ChildResult;
        try {
          r = await deps.runChild({
            command: "docker", args, cwd: ctx.attemptDir, cwdRoot: ctx.attemptDir, envAllow: ["PATH"],
            timeoutMs: lim.timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES, signal: ctx.signal, stageRunId: ctx.claim.stageRunId,
            onLine: (line) => {
              const p = parseProgress(line);
              if (p !== null) return ctx.log(`render: ${p}%`);
              const clean = redactLine(line).slice(0, 300);
              if (!clean.trim()) return;
              ctx.log(`render: ${clean}`);
              tail.push(clean);
              if (tail.length > 8) tail.shift();
            },
          });
        } finally {
          // Killing the docker CLI does not stop the container: always remove it by name, with its own signal.
          await deps.runChild({
            command: "docker", args: ["rm", "-f", name], cwd: ctx.attemptDir, envAllow: ["PATH"], timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
            signal: new AbortController().signal, stageRunId: ctx.claim.stageRunId,
          }).catch(() => undefined);
        }
        if (r.aborted) throw ctx.signal.reason ?? new Error("render aborted");
        if (r.timedOut) throw new KnownFailure(`The render took longer than its ${Math.ceil(lim.timeoutS / 60)} min limit and was stopped.`);
        if (r.truncated) throw new KnownFailure("The render printed too much output and was stopped.");
        if (r.code !== 0) throw new KnownFailure(`The render failed (exit ${r.code ?? r.signal}). Last lines: ${tail.slice(-3).join(" | ")}`.slice(0, 600));

        const outPath = path.join(ctx.attemptDir, a.outFile);
        await rm(outPath, { force: true });
        await copyRegular(path.join(outDir, "out.mp4"), outPath).catch(() => {
          throw new KnownFailure("The render finished but made no video file.");
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
        return { outPath };
      } finally {
        await cleanup();
      }
    },
  };
}
