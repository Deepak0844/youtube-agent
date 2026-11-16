import { badCheck, dockerVersion, ffVersion, okCheck, type ToolCheck } from "@/server/core/tool-check";
import { cleanEnv, exec } from "./probe";
import type { ContainerRunner } from "@/server/providers/renderer/container-runner";
import { RENDER_IMAGE } from "./runner";

// Runs the tool checks: fixed commands, no shell, no user input, a short time limit each, a clean environment. Nothing from a failure
// (paths, messages) is kept: the answer is a plain sentence. `exec` is injectable for tests.

type Exec = typeof exec;
const TIMEOUT_MS = 5_000;
const CACHE_MS = 60_000;

async function run(ex: Exec, bin: string, args: string[], env: Record<string, string>): Promise<string | null> {
  try {
    return (await ex(bin, args, { env, timeoutMs: TIMEOUT_MS, signal: AbortSignal.timeout(TIMEOUT_MS + 1000) })).toString("utf8");
  } catch {
    return null;
  }
}

/** With `runner` (compose), Docker and the render image are answered by the render service; the local docker is never asked. */
export async function runToolChecks(o: { exec?: Exec; env?: Record<string, string | undefined>; runner?: Pick<ContainerRunner, "info"> } = {}): Promise<ToolCheck[]> {
  const ex = o.exec ?? exec;
  const env = cleanEnv((o.env ?? process.env) as NodeJS.ProcessEnv);
  const out: ToolCheck[] = [];
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const text = await run(ex, tool, ["-version"], env);
    const v = text === null ? null : ffVersion(text, tool);
    out.push(v ? okCheck(tool, `version ${v}`) : badCheck(tool, text === null ? "Not found." : "Found, but it did not answer like ffmpeg."));
  }
  if (o.runner) {
    const fixService = "Start the render service: docker compose up -d render-runner";
    let info: Awaited<ReturnType<ContainerRunner["info"]>> | null = null;
    try { info = await o.runner.info(); } catch { /* the rows below say it */ }
    if (info === null) {
      out.push({ ...badCheck("docker", "The render service is not reachable."), fix: fixService });
      out.push({ ...badCheck("render_image", "Cannot be checked until the render service runs."), fix: fixService });
    } else if (info.dockerVersion === null) {
      out.push({ ...badCheck("docker", "The render service cannot reach Docker."), fix: "Check the render service's Docker socket: docker compose logs render-runner" });
      out.push(badCheck("render_image", "Cannot be checked until Docker runs."));
    } else {
      out.push(okCheck("docker", `version ${info.dockerVersion} (through the render service)`));
      out.push(info.image.pinned ? okCheck("render_image", "Built and ready.") : badCheck("render_image", "Not built on this computer (run npm run image:render)."));
    }
    return out;
  }
  const dockerOut = await run(ex, "docker", ["info", "--format", "{{.ServerVersion}}"], env);
  const dv = dockerOut === null ? null : dockerVersion(dockerOut);
  out.push(dv ? okCheck("docker", `version ${dv}`) : badCheck("docker", "Not running or not installed."));
  if (!dv) {
    out.push(badCheck("render_image", "Cannot be checked until Docker runs."));
  } else {
    const image = await run(ex, "docker", ["image", "inspect", RENDER_IMAGE, "--format", "{{.Id}}"], env);
    out.push(image !== null && /^sha256:[0-9a-f]{12,}/.test(image.trim()) ? okCheck("render_image", "Built and ready.") : badCheck("render_image", "Not built on this computer."));
  }
  return out;
}

let cache: { at: number; checks: ToolCheck[] } | null = null;

/** Same as runToolChecks, but remembered for a minute so reloading the page does not start four processes every time. */
export async function cachedToolChecks(now: () => number = Date.now, run: () => Promise<ToolCheck[]> = runToolChecks): Promise<ToolCheck[]> {
  if (cache && now() - cache.at < CACHE_MS) return cache.checks;
  const checks = await run();
  cache = { at: now(), checks };
  return checks;
}
