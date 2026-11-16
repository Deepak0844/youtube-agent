import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { NotProcessedError } from "@/server/core/error-class";
import { redactLine } from "@/server/core/log-redact";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { ChildResult, ChildSpec } from "@/server/render/child";
import { JOB_LABEL, daemonLimits, RENDER_IMAGE, type HostLimits } from "@/server/render/runner";
import { mountable, NAME_PREFIX, parseRenderContainers, RENDER_NAME, renderLimits, renderPlan, WORKER_LABEL, type RenderJob, type RenderRequest } from "@/server/render/render-job";
import { parseProgress, realDir, runRenderContainer } from "./remotion-container";

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

export interface HttpRunnerDeps {
  /** The render service, e.g. http://render-runner:4100 */
  url: string;
  token: string;
  /** The storage root as this worker sees it: a request's absolute folders are sent relative to it. */
  storageRoot: string;
  fetch?: typeof fetch;
  /** Extra time on top of the job's own limit before the worker gives up on the service. Default 30 s. */
  requestTimeoutMarginMs?: number;
}

/**
 * The render service adapter: the worker sends a job description and reads the progress stream; the service alone talks to Docker.
 * The token travels only in the Authorization header and never appears in a message or a log line.
 */
export function createHttpRunner(deps: HttpRunnerDeps): ContainerRunner {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.url.replace(/\/+$/, "");
  const margin = deps.requestTimeoutMarginMs ?? 30_000;

  /** One request. A connection that fails is "not reachable"; an abort we asked for is rethrown as is. */
  async function call(pathname: string, init: RequestInit & { headers?: Record<string, string> }, signal?: AbortSignal): Promise<Response> {
    try {
      // redirect: "error": the service never redirects, and a token must never follow one somewhere else.
      return await doFetch(base + pathname, { ...init, redirect: "error", headers: { ...init.headers, authorization: `Bearer ${deps.token}` }, ...(signal && { signal }) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new NotProcessedError("The render service is not reachable.");
    }
  }

  const relative = (abs: string): string => {
    const rel = path.isAbsolute(abs) ? path.relative(deps.storageRoot, abs) : "..";
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new KnownFailure("A render folder cannot be sent to the render service (it is outside the storage root).");
    return rel.split(path.sep).join("/");
  };

  async function info(): Promise<RunnerInfo> {
    const res = await call("/v1/info", {});
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status === 401 || res.status === 403) throw new KnownFailure("The render service refused the request."); // a wrong token is a setting to fix, not a hiccup to retry
      throw new NotProcessedError("The render service is not reachable.");
    }
    const { host, image, dockerVersion } = (await res.json()) as RunnerInfo;
    return { host, image, dockerVersion };
  }

  return {
    info,

    async run(ctx, request) {
      const { inDir, outDir, ...rest } = request;
      const job: RenderJob = { ...rest, inDir: relative(inDir), outDir: relative(outDir) };
      const limits = renderLimits(job.kind, job.config);
      const { image } = await info();
      if (!image.pinned) ctx.log(`render: image not pinned (could not resolve its id); running the tag ${image.ref}`);

      const ac = new AbortController();
      let stageAborted = false;
      let timedOut = false;
      const onAbort = () => { stageAborted = true; ac.abort(); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limits.timeoutMs + margin);
      const tail: string[] = [];
      const interrupted = (): RenderRunResult => ({ r: { code: null, signal: null, timedOut, truncated: false, aborted: stageAborted && !timedOut }, tail, image: image.ref });
      try {
        let res: Response;
        try {
          res = await call("/v1/render", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) }, ac.signal);
        } catch (e) {
          if (ac.signal.aborted) return interrupted();
          throw e;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          if (res.status >= 500) throw new NotProcessedError("The render service could not run the job.");
          throw new KnownFailure("The render service refused the job.");
        }

        let end: RenderRunResult["r"] | null = null;
        const onLine = (line: string) => {
          const p = parseProgress(line);
          if (p !== null) { ctx.progress?.(p); return ctx.log(`render: ${p}%`); }
          const clean = redactLine(line).slice(0, 300);
          if (!clean.trim()) return;
          ctx.log(`render: ${clean}`);
          tail.push(clean);
          if (tail.length > 8) tail.shift();
        };
        const handle = (text: string) => {
          if (!text.trim()) return;
          let ev: { t?: unknown; s?: unknown; code?: unknown; signal?: unknown; timedOut?: unknown; truncated?: unknown; error?: unknown };
          try { ev = JSON.parse(text) as typeof ev; } catch { return; }
          if (ev.t === "line" && typeof ev.s === "string") onLine(ev.s);
          else if (ev.t === "end") {
            if (typeof ev.error === "string") throw new NotProcessedError("The render service could not run the job.");
            end = { code: typeof ev.code === "number" ? ev.code : null, signal: typeof ev.signal === "string" ? ev.signal : null, timedOut: ev.timedOut === true, truncated: ev.truncated === true, aborted: false };
          }
        };
        try {
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
          }
          handle(buf);
        } catch (e) {
          if (ac.signal.aborted) return interrupted();
          if (e instanceof NotProcessedError) throw e;
          throw new NotProcessedError("The render service stopped answering.");
        }
        if (end === null) {
          if (ac.signal.aborted) return interrupted();
          throw new NotProcessedError("The render service stopped answering.");
        }
        return { r: end, tail, image: image.ref };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },

    async list() {
      try {
        const res = await call("/v1/containers", {});
        if (!res.ok) { await res.body?.cancel().catch(() => undefined); return []; }
        const rows = (await res.json()) as unknown;
        return Array.isArray(rows) ? parseRenderContainers(rows.map((r: { name?: unknown; worker?: unknown }) => `${String(r.name)} ${String(r.worker)}`).join("\n")) : [];
      } catch {
        return []; // a clean-up must never throw
      }
    },

    async remove(name) {
      if (!RENDER_NAME.test(name)) throw new Error("not a render container");
      const res = await call(`/v1/render/${encodeURIComponent(name)}`, { method: "DELETE" });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok && res.status !== 404) throw new NotProcessedError("The render service could not remove the container.");
    },
  };
}

const bothOrNeither = (env: Record<string, string | undefined>): { url: string; token: string } | null => {
  const url = env.RENDER_RUNNER_URL?.trim() ?? "";
  const token = env.RENDER_RUNNER_TOKEN?.trim() ?? "";
  if (url === "" && token === "") return null;
  if (url === "" || token === "") throw new Error("RENDER_RUNNER_URL and RENDER_RUNNER_TOKEN must be set together");
  return { url, token };
};

/** True when the worker is to ask the render service (compose); false when it runs docker itself (native). Half a setting is an error. */
export const usesRenderService = (env: Record<string, string | undefined>): boolean => bothOrNeither(env) !== null;

/** The runner for this environment: the render service when RENDER_RUNNER_URL and RENDER_RUNNER_TOKEN are both set, else docker. Never a silent fallback. */
export function selectRunner(env: Record<string, string | undefined>, deps: { docker: DockerRunnerDeps; storageRoot: string }): ContainerRunner {
  const svc = bothOrNeither(env);
  if (svc === null) return createDockerRunner(deps.docker);
  if (!/^https?:\/\//.test(svc.url)) throw new Error("RENDER_RUNNER_URL must be an http(s) address");
  return createHttpRunner({ url: svc.url, token: svc.token, storageRoot: deps.storageRoot });
}
