import path from "node:path";
import { KnownFailure } from "@/server/core/paid-call";
import { JOB_LABEL, lockFlags, type HostLimits } from "./runner";

// The pure part of a render: how a job becomes the exact `docker run` arguments of the locked-down render container (ADR 0003, 0009).
// No IO here, so the worker (native) and the render service (compose) build byte-identical commands from the same code.

export const NAME_PREFIX = "ytstudio-render-";
export const WORKER_LABEL = "ytstudio.worker";
export const WORKER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MOUNT_SAFE = /^[^:,\0\r\n]+$/;

export interface RenderArgsInput {
  name: string;
  limits: { cpus: number; memoryMb: number; pids: number };
  host: HostLimits;
  imageRef: string;
  workerId?: string;
  /** Mount sources: absolute, already checked with mountable() and realDir(). */
  inDir: string;
  outDir: string;
  kitDir?: string;
  /** Rewrites /in and /out mount sources to host paths (worker in a container). */
  hostPath?: (p: string) => string;
  /** Extra hardening flags placed after the shared locks; only ever adds limits (see render/render-job.ts). */
  extra?: readonly string[];
  /** Arguments of render-entry.mjs (after the image). Default: the kit render, /in /out/out.mp4. */
  entry?: readonly string[];
}

/** The `docker run` argument list of one render. Builds only; runs nothing. */
const same = (p: string) => p;
export function renderArgs(o: RenderArgsInput): string[] {
  return [
    "run", "--rm", "--name", o.name,
    ...lockFlags(o.limits, o.host),
    ...(o.extra ?? []),
    "--log-driver", "none",
    "--label", `${JOB_LABEL}=${o.name}`,
    "--label", `${WORKER_LABEL}=${o.workerId && WORKER_ID.test(o.workerId) ? o.workerId : "unknown"}`,
    "-v", `${(o.hostPath ?? same)(o.inDir)}:/in:ro`,
    "-v", `${(o.hostPath ?? same)(o.outDir)}:/out:rw`,
    ...(o.kitDir === undefined ? [] : ["-v", `${o.kitDir}:/opt/render/kit:ro`]),
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

/** The `--frames` argument of one chapter chunk: whole numbers, from at most to. Anything else is a plain refusal. */
export function chunkArg(chunk: { from: number; to: number | "end" }): string {
  const ok = Number.isInteger(chunk.from) && chunk.from >= 0 && chunk.from <= 9_999_999 && (chunk.to === "end" || (Number.isInteger(chunk.to) && chunk.to >= chunk.from && chunk.to <= 9_999_999));
  if (!ok) throw new KnownFailure("The chapter frame range is not valid. Nothing was rendered.");
  return `--frames=${chunk.from}-${chunk.to}`;
}


// SECURITY CONTROL (ADR 0009, the boundary for the TSX path): model-written code runs only inside the same hardened render
// container as the scene kit (renderArgs + lockFlags: no network, read-only root, noexec /tmp tmpfs, cap-drop ALL,
// no-new-privileges, uid 10001, pids/memory/cpu limits, no env, three exact mounts) with tighter limits on top. Every value
// here can only lower a limit: the config and the daemon can make them smaller, never bigger. Builds the plan only; runs
// nothing (tsx-render.ts runs it; slice 3 wires that into the render step).

const MiB = 1024 * 1024;
export const TSX_SANDBOX = {
  cpus: 2,
  memoryMb: 2048,
  pids: 256,
  /** Hard wall-clock cap; also never more than half the kit render limit. */
  timeoutS: 300,
  /** A full OpenMontage video (om-video) may be long: it gets the kit's own render limit, at most this. Same flags otherwise. */
  omVideoTimeoutS: 1800,
  /** Largest file any process in the container may write (ulimit fsize); also the cap on the copied-out video. */
  maxFileBytes: 512 * MiB,
  /** Cap on what the docker CLI may print back. */
  maxOutputBytes: 256 * 1024,
} as const;

/** Added after the shared locks: no core dumps, and a kernel-enforced cap on the size of every file written. */
export const TSX_EXTRA_FLAGS: readonly string[] = [
  "--ulimit", `fsize=${TSX_SANDBOX.maxFileBytes}:${TSX_SANDBOX.maxFileBytes}`,
  "--ulimit", "core=0:0",
];

export interface TsxRenderPlan {
  args: string[];
  timeoutMs: number;
  maxVideoBytes: number;
  maxOutputBytes: number;
}

export type TsxRenderPlanInput = Omit<RenderArgsInput, "limits" | "extra" | "entry"> & {
  /** The kit render settings (EngineConfig.render); the TSX plan is clamped below them. */
  config: { timeoutS: number; cpus: number; memoryMb: number; pids: number };
  /** "stills": the preflight frames as /out/still-<n>.png; "video": /out/out.mp4. The om- modes draw an OpenMontage scene list instead. Same flags and limits for all. */
  mode: keyof typeof TSX_ENTRY;
};

/** render-entry.mjs arguments per mode (/in holds video.tsx (TSX only), props.json, meta.json and public/). */
export const TSX_ENTRY = {
  stills: ["/in", "/out", "--tsx-stills"],
  video: ["/in", "/out/out.mp4", "--tsx"],
  "om-stills": ["/in", "/out", "--om-stills"],
  "om-video": ["/in", "/out/out.mp4", "--om"],
} as const;

/** The docker args and limits of one TSX render. Throws on unusable settings (never falls back to looser ones). */
export function tsxRenderPlan(o: TsxRenderPlanInput): TsxRenderPlan {
  const { config: c, mode, ...rest } = o;
  for (const v of [c.timeoutS, c.cpus, c.memoryMb, c.pids]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error("invalid render settings");
  }
  if (!Object.hasOwn(TSX_ENTRY, mode)) throw new Error("invalid TSX render mode");
  const limits = {
    cpus: Math.min(c.cpus, TSX_SANDBOX.cpus),
    memoryMb: Math.min(c.memoryMb, TSX_SANDBOX.memoryMb),
    pids: Math.min(c.pids, TSX_SANDBOX.pids),
  };
  const timeoutS = mode === "om-video" ? Math.max(1, Math.min(TSX_SANDBOX.omVideoTimeoutS, Math.floor(c.timeoutS))) : Math.max(1, Math.min(TSX_SANDBOX.timeoutS, Math.floor(c.timeoutS / 2)));
  return {
    args: renderArgs({ ...rest, limits, extra: TSX_EXTRA_FLAGS, entry: TSX_ENTRY[mode] }),
    timeoutMs: timeoutS * 1000,
    maxVideoBytes: TSX_SANDBOX.maxFileBytes,
    maxOutputBytes: TSX_SANDBOX.maxOutputBytes,
  };
}
