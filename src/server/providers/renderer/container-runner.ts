import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { JOB_LABEL, daemonLimits, RENDER_IMAGE, type HostLimits } from "@/server/render/runner";
import { mountable, NAME_PREFIX, parseRenderContainers, RENDER_NAME, renderPlan, WORKER_LABEL, type RenderRequest } from "@/server/render/render-job";
import { realDir, runRenderContainer } from "./remotion-container";

// The one way the worker runs a render. A renderer describes a job (render-job.ts); a ContainerRunner runs it. Two adapters:
//  - dockerRunner: the worker calls docker itself (native Mac setup, and compose before the render service);
//  - httpRunner (http-runner.ts): the worker asks the render service, which alone holds the Docker socket in compose.
// Both build the command with the same renderPlan, so the sandbox is the same either way.

export interface RenderRunResult {
  r: { code: number | null; signal: string | null; timedOut: boolean; truncated: boolean; aborted: boolean };
  /** The last few output lines (redacted), for failure messages. */
  tail: string[];
  /** The image the render ran: its sha256 id when pinned, else the tag. */
  image: string;
}

export interface RunnerInfo {
  host: HostLimits;
  image: { ref: string; pinned: boolean };
  dockerVersion: string | null;
}

export interface ContainerRunner {
  run(ctx: StageContext, req: RenderRequest): Promise<RenderRunResult>;
  info(): Promise<RunnerInfo>;
  /** Render containers that exist now (running or not), with the worker label they carry. */
  list(): Promise<Array<{ name: string; worker: string }>>;
  /** Removes one render container by name; refuses any name that is not a render container's. */
  remove(name: string): Promise<void>;
}

const execDocker = promisify(execFile);
const dockerEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin" }) as unknown as NodeJS.ProcessEnv; // PATH only: no DOCKER_HOST/CONFIG, no secrets

export interface DockerRunnerDeps {
  runChild(spec: ChildSpec): Promise<ChildResult>;
  /** Dev override: a working copy of remotion/kit mounted read-only over the one baked into the image. */
  kitDir?: string;
  /** Host-side path of a folder under the storage root (a worker in a container without the render service). Default: as is. */
  hostPath?: (p: string) => string;
  hostLimits?: () => Promise<HostLimits>;
  /** The image to run: its sha256 id when resolved at boot (pinned), else the tag. Default: the tag, unpinned. */
  image?: () => Promise<{ ref: string; pinned: boolean }>;
  sweepDelayMs?: number;
  /** The docker CLI for info/list/remove. Default: `docker` with only PATH in its environment. */
  exec?: (args: string[]) => Promise<string>;
}

export function createDockerRunner(deps: DockerRunnerDeps): ContainerRunner {
  const exec = deps.exec ?? (async (args: string[]) => (await execDocker("docker", args, { env: dockerEnv(), timeout: 30_000 })).stdout);
  const image = () => (deps.image ? deps.image() : Promise.resolve({ ref: RENDER_IMAGE, pinned: false }));
  return {
    async run(ctx, job) {
      const inDir = mountable(job.inDir);
      const outDir = mountable(job.outDir);
      if (deps.kitDir !== undefined) await realDir(mountable(deps.kitDir), "kit"); // dev override only
      const host = await (deps.hostLimits ?? daemonLimits)();
      const img = await image();
      if (!img.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${img.ref}`);
      const plan = renderPlan(job, { host, imageRef: img.ref, inDir, outDir, ...(deps.kitDir !== undefined && { kitDir: deps.kitDir }), ...(deps.hostPath && { hostPath: deps.hostPath }) });
      const { r, tail } = await runRenderContainer(deps, ctx, { name: job.name, args: plan.args, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes });
      return { r: { code: r.code, signal: r.signal, timedOut: r.timedOut, truncated: r.truncated, aborted: r.aborted }, tail, image: img.ref };
    },

    async info() {
      const dockerVersion = await exec(["info", "--format", "{{.ServerVersion}}"]).then((o) => o.trim() || null, () => null);
      return { host: await (deps.hostLimits ?? daemonLimits)(), image: await image(), dockerVersion };
    },

    async list() {
      try {
        return parseRenderContainers(await exec(["ps", "-a", "--filter", `label=${JOB_LABEL}`, "--filter", `label=${WORKER_LABEL}`, "--filter", `name=${NAME_PREFIX}`, "--format", `{{.Names}} {{.Label "${WORKER_LABEL}"}}`]));
      } catch {
        return []; // a clean-up must never throw
      }
    },

    async remove(name) {
      if (!RENDER_NAME.test(name)) throw new Error("not a render container");
      await exec(["rm", "-f", name]);
    },
  };
}
