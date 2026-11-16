import path from "node:path";
import { z } from "zod";
import { KnownFailure } from "@/server/core/paid-call";
import { JOB_LABEL, lockFlags, type HostLimits } from "./runner";

// The pure part of a render: how a job becomes the exact `docker run` arguments of the locked-down render container (ADR 0003, 0009).
// No IO here, so the worker (native) and the render service (compose) build byte-identical commands from the same code.

export const NAME_PREFIX = "ytstudio-render-";
export const WORKER_LABEL = "ytstudio.worker";
export const WORKER_ID = /^[A-Za-z0-9_.-]{1,64}$/;
/** What the docker CLI may print back from a kit render. */
export const MAX_OUTPUT_BYTES = 1024 * 1024;
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

/** The wall-clock limit of a code-scene render: half the kit limit (at most 300 s), or the kit's own limit (at most 1800 s) for a whole OpenMontage video. */
function tsxTimeoutS(mode: keyof typeof TSX_ENTRY, kitTimeoutS: number): number {
  return mode === "om-video" ? Math.max(1, Math.min(TSX_SANDBOX.omVideoTimeoutS, Math.floor(kitTimeoutS))) : Math.max(1, Math.min(TSX_SANDBOX.timeoutS, Math.floor(kitTimeoutS / 2)));
}

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
  const timeoutS = tsxTimeoutS(mode, c.timeoutS);
  return {
    args: renderArgs({ ...rest, limits, extra: TSX_EXTRA_FLAGS, entry: TSX_ENTRY[mode] }),
    timeoutMs: timeoutS * 1000,
    maxVideoBytes: TSX_SANDBOX.maxFileBytes,
    maxOutputBytes: TSX_SANDBOX.maxOutputBytes,
  };
}

// ---- the job: what the worker hands over, and what the render service validates ----

export const RENDER_KINDS = ["kit", "kit-landscape", "thumbnail", "tsx-stills", "tsx-video", "om-stills", "om-video", "clip"] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];

/** A folder inside the storage root, relative to it: no `..`, no `.` segments, no absolute path, no characters that could add mount options. */
const relativeFolder = z.string().min(1).max(200).refine(
  (p) => /^[^:,\0\r\n]+$/.test(p) && !p.startsWith("/") && !p.endsWith("/") && path.posix.normalize(p) === p && p !== "." && p.split("/").every((seg) => seg !== ".."),
  "not a plain relative folder",
);

const limit = (max: number) => z.number().finite().positive().max(max);
const frame = z.number().int().min(0).max(9_999_999);

export const renderJobSchema = z
  .object({
    kind: z.enum(RENDER_KINDS),
    /** Container name: the render prefix and a short safe tail. */
    name: z.string().regex(/^ytstudio-render-[A-Za-z0-9_.-]{1,60}$/),
    inDir: relativeFolder,
    outDir: relativeFolder,
    worker: z.string().regex(WORKER_ID).optional(),
    /** The engine's render settings; renderPlan only ever lowers them. */
    config: z.object({ timeoutS: limit(7200), cpus: limit(64), memoryMb: limit(65536), pids: limit(4096) }).strict(),
    /** kit-landscape only: render one chapter's frames, muted (the host joins the chapters and lays the narration on). */
    chunk: z.object({ from: frame, to: z.union([z.literal("end"), frame]) }).strict().optional(),
  })
  .strict()
  .superRefine((j, ctx) => {
    if (j.chunk && j.kind !== "kit-landscape") ctx.addIssue({ code: "custom", message: "chunk is only for kit-landscape", path: ["chunk"] });
    if (j.chunk && j.chunk.to !== "end" && j.chunk.to < j.chunk.from) ctx.addIssue({ code: "custom", message: "chunk ends before it starts", path: ["chunk"] });
  });
export type RenderJob = z.infer<typeof renderJobSchema>;

/** What a renderer hands the ContainerRunner: the same job with its two folders as the absolute paths it already holds. The service adapter turns them into the relative folders of a RenderJob. */
export type RenderRequest = Omit<RenderJob, "inDir" | "outDir"> & { inDir: string; outDir: string };

export interface RenderPlan {
  args: string[];
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * The exact `docker run` arguments, wall-clock limit and output cap of one job. `at` holds what only the caller knows: the daemon's
 * limits, the image reference, the absolute folders it resolved, and (native dev only) a kit folder and a host-path rewrite. The job
 * never names an image, a mount, or a flag: nothing it contains can change what runs.
 */
export function renderPlan(job: Omit<RenderJob, "inDir" | "outDir">, at: { host: HostLimits; imageRef: string; inDir: string; outDir: string; kitDir?: string; hostPath?: (p: string) => string }): RenderPlan {
  const common = { name: job.name, host: at.host, imageRef: at.imageRef, workerId: job.worker, inDir: at.inDir, outDir: at.outDir, kitDir: at.kitDir, hostPath: at.hostPath };
  const c = job.config;
  const limits = { cpus: c.cpus, memoryMb: c.memoryMb, pids: c.pids };
  const { timeoutMs, maxOutputBytes } = renderLimits(job.kind, c);
  switch (job.kind) {
    case "kit":
      return { args: renderArgs({ ...common, limits }), timeoutMs, maxOutputBytes };
    case "kit-landscape":
      return { args: renderArgs({ ...common, limits, entry: ["/in", "/out/out.mp4", "--landscape", ...(job.chunk ? [chunkArg(job.chunk), "--muted"] : [])] }), timeoutMs, maxOutputBytes };
    case "thumbnail":
      return { args: renderArgs({ ...common, limits, entry: ["/in", "/out/out.png", "--thumbnail"] }), timeoutMs, maxOutputBytes };
    case "clip":
      return { args: renderArgs({ ...common, limits, extra: TSX_EXTRA_FLAGS, entry: ["/in", "/out/out.mp4", "--clip"] }), timeoutMs, maxOutputBytes };
    default: {
      const mode = ({ "tsx-stills": "stills", "tsx-video": "video", "om-stills": "om-stills", "om-video": "om-video" } as const)[job.kind];
      return { args: tsxRenderPlan({ ...common, config: c, mode }).args, timeoutMs, maxOutputBytes };
    }
  }
}

/** The four engine settings a job carries, picked by name (the wire schema is strict: nothing else may ride along). */
export const renderConfig = (c: { timeoutS: number; cpus: number; memoryMb: number; pids: number }) => ({ timeoutS: c.timeoutS, cpus: c.cpus, memoryMb: c.memoryMb, pids: c.pids });

/**
 * The wall-clock limit and output cap of a job, without building the command: the renderers quote the limit in their failure messages.
 * Throws "invalid render settings" for the code-scene and clip kinds on a non-positive or non-finite setting, as tsxRenderPlan always did.
 */
export function renderLimits(kind: RenderKind, c: RenderJob["config"]): { timeoutMs: number; maxOutputBytes: number } {
  switch (kind) {
    case "kit":
    case "kit-landscape":
      return { timeoutMs: c.timeoutS * 1000, maxOutputBytes: MAX_OUTPUT_BYTES };
    case "thumbnail":
      return { timeoutMs: Math.min(c.timeoutS, 300) * 1000, maxOutputBytes: 256 * 1024 };
    default: {
      for (const v of [c.timeoutS, c.cpus, c.memoryMb, c.pids]) if (!Number.isFinite(v) || v <= 0) throw new Error("invalid render settings");
      if (kind === "clip") return { timeoutMs: Math.floor(c.timeoutS) * 1000, maxOutputBytes: TSX_SANDBOX.maxOutputBytes };
      const mode = ({ "tsx-stills": "stills", "tsx-video": "video", "om-stills": "om-stills", "om-video": "om-video" } as const)[kind];
      return { timeoutMs: tsxTimeoutS(mode, c.timeoutS) * 1000, maxOutputBytes: TSX_SANDBOX.maxOutputBytes };
    }
  }
}

/** The name of a render container: the render prefix and a short safe tail (the same pattern a job's name must match). */
export const RENDER_NAME = new RegExp(`^${NAME_PREFIX}[A-Za-z0-9_.-]{1,60}$`);

/** Parses `docker ps --format '{{.Names}} {{.Label "ytstudio.worker"}}'` into render containers; anything malformed is skipped. */
export function parseRenderContainers(out: string): Array<{ name: string; worker: string }> {
  const rows: Array<{ name: string; worker: string }> = [];
  for (const line of out.split("\n")) {
    const parts = line.trim().split(" ");
    if (parts.length !== 2) continue;
    const [name, worker] = parts as [string, string];
    if (RENDER_NAME.test(name) && WORKER_ID.test(worker)) rows.push({ name, worker });
  }
  return rows;
}
