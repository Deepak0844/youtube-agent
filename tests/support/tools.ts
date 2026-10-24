import { spawnSync } from "node:child_process";

// Tests that probe rendered video need the host's ffprobe (part of ffmpeg). Fail up front with the fix.
export function assertFfprobeAvailable(env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync("ffprobe", ["-version"], { env, encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error("ffprobe not found on PATH. Install ffmpeg and retry.");
}
