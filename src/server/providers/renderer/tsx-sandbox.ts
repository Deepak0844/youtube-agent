import { renderArgs, type RenderArgsInput } from "./remotion-container";

// SECURITY CONTROL (ADR 0009, the boundary for the TSX path): model-written code runs only inside the same hardened render
// container as the scene kit (renderArgs + lockFlags: no network, read-only root, noexec /tmp tmpfs, cap-drop ALL,
// no-new-privileges, uid 10001, pids/memory/cpu limits, no env, three exact mounts) with tighter limits on top. Every value
// here can only lower a limit: the config and the daemon can make them smaller, never bigger. Builds the plan only; runs
// nothing (slice 3 wires it into the render step).

const MiB = 1024 * 1024;
export const TSX_SANDBOX = {
  cpus: 2,
  memoryMb: 2048,
  pids: 256,
  /** Hard wall-clock cap; also never more than half the kit render limit. */
  timeoutS: 300,
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

export type TsxRenderPlanInput = Omit<RenderArgsInput, "limits" | "extra"> & {
  /** The kit render settings (EngineConfig.render); the TSX plan is clamped below them. */
  config: { timeoutS: number; cpus: number; memoryMb: number; pids: number };
};

/** The docker args and limits of one TSX render. Throws on unusable settings (never falls back to looser ones). */
export function tsxRenderPlan(o: TsxRenderPlanInput): TsxRenderPlan {
  const { config: c, ...rest } = o;
  for (const v of [c.timeoutS, c.cpus, c.memoryMb, c.pids]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error("invalid render settings");
  }
  const limits = {
    cpus: Math.min(c.cpus, TSX_SANDBOX.cpus),
    memoryMb: Math.min(c.memoryMb, TSX_SANDBOX.memoryMb),
    pids: Math.min(c.pids, TSX_SANDBOX.pids),
  };
  const timeoutS = Math.max(1, Math.min(TSX_SANDBOX.timeoutS, Math.floor(c.timeoutS / 2)));
  return {
    args: renderArgs({ ...rest, limits, extra: TSX_EXTRA_FLAGS }),
    timeoutMs: timeoutS * 1000,
    maxVideoBytes: TSX_SANDBOX.maxFileBytes,
    maxOutputBytes: TSX_SANDBOX.maxOutputBytes,
  };
}
