import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { JOB_LABEL, daemonLimits } from "../../src/server/render/runner";
import { NAME_PREFIX, parseRenderContainers, RENDER_NAME, WORKER_LABEL } from "../../src/server/render/render-job";
import { runChild } from "../../src/server/render/child";
import type { RunnerConfig } from "./config";
import type { RunnerDeps } from "./server";

// The service's real wiring: the docker CLI with only PATH in its environment (no DOCKER_HOST, no secrets).
const run = promisify(execFile);
const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv; // PATH only: no DOCKER_HOST, no secrets
const docker = async (args: string[]): Promise<string> => (await run("docker", args, { env, timeout: 30_000 })).stdout;

/**
 * HOST_STORAGE_ROOT is the host-side path the Docker daemon mounts for every render. If it names another folder, renders see the wrong (often empty)
 * input and fail in confusing ways. A throwaway container mounts it read-only and lists its top-level names; they must equal this service's own
 * listing of its storage root. A good answer is remembered for 10 minutes; a bad one is asked again each time.
 */
export function hostRootChecker(cfg: Pick<RunnerConfig, "root" | "hostRoot" | "image">, list: (dir: string) => Promise<string[]> = (d) => readdir(d), probe: (args: string[]) => Promise<string> = docker, now: () => number = Date.now): () => Promise<string | null> {
  let okUntil = 0;
  return async () => {
    if (now() < okUntil) return null;
    try {
      const mine = (await list(cfg.root)).sort().join("\n");
      const theirs = (await probe(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "-v", `${cfg.hostRoot}:/probe:ro`, "--entrypoint", "ls", cfg.image, "-1A", "/probe"])).split("\n").filter(Boolean).sort().join("\n");
      if (mine === theirs) { okUntil = now() + 600_000; return null; }
      return `HOST_STORAGE_ROOT (${cfg.hostRoot}) is not the folder mounted at ${cfg.root}: renders would see the wrong files. Set it to the host path of the data folder.`;
    } catch {
      return "HOST_STORAGE_ROOT could not be checked: a test container did not start.";
    }
  };
}

export const dockerDeps = (cfg: Pick<RunnerConfig, "token" | "root" | "hostRoot" | "image">): RunnerDeps => ({
  token: cfg.token,
  root: cfg.root,
  hostRoot: cfg.hostRoot,
  hostLimits: daemonLimits,
  hostRootProblem: hostRootChecker(cfg),
  dockerVersion: () => docker(["info", "--format", "{{.ServerVersion}}"]).then((o) => o.trim() || null, () => null),
  // Pinned by its sha256 id when docker can say it, else the tag (the worker did the same at its boot).
  image: async () => {
    const id = await docker(["image", "inspect", "-f", "{{.Id}}", cfg.image]).then((o) => o.trim(), () => "");
    return /^sha256:[0-9a-f]{64}$/.test(id) ? { ref: id, pinned: true } : { ref: cfg.image, pinned: false };
  },
  exec: async (args, o) => {
    const r = await runChild({
      command: "docker", args, cwd: "/tmp", envAllow: ["PATH"], timeoutMs: o.timeoutMs, maxOutputBytes: o.maxOutputBytes,
      signal: o.signal ?? new AbortController().signal, ...(o.onLine && { onLine: o.onLine }), stageRunId: "render-runner",
    });
    return { code: r.code, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated };
  },
  listContainers: async () => {
    try {
      return parseRenderContainers(await docker(["ps", "-a", "--filter", `label=${JOB_LABEL}`, "--filter", `label=${WORKER_LABEL}`, "--filter", `name=${NAME_PREFIX}`, "--format", `{{.Names}} {{.Label "${WORKER_LABEL}"}}`]));
    } catch {
      return [];
    }
  },
  removeContainer: async (name) => {
    if (!RENDER_NAME.test(name)) throw new Error("not a render container");
    await docker(["rm", "-f", name]);
  },
});
