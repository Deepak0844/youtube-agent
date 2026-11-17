import http from "node:http";
import { renderJobSchema, renderPlan, RENDER_NAME, type RenderJob } from "../../src/server/render/render-job";
import type { HostLimits } from "../../src/server/render/runner";
import { authorized, readBody, resolveJobDirs } from "./checks";

// SECURITY CONTROL: the render service, the only component with the Docker socket. It accepts a JobDescription, never docker arguments:
// the command comes from renderPlan (the same pure function the worker uses natively), the image and the mount prefix from the
// service's own settings. Token on every route, schema-validated input, real folders inside the data root only, one render at a time,
// and the container is removed whatever happens. It holds no secret and talks to nothing but Docker.

export interface ExecOpts {
  onLine?(line: string): void;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}
export interface ExecResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunnerDeps {
  token: string;
  /** The data folder inside this container (read to validate paths, never written). */
  root: string;
  /** The same folder as the Docker daemon sees it: the prefix of every mount source. */
  hostRoot: string;
  image(): Promise<{ ref: string; pinned: boolean }>;
  hostLimits(): Promise<HostLimits>;
  dockerVersion(): Promise<string | null>;
  /** null when HOST_STORAGE_ROOT is the folder this service sees as its storage root; else a plain sentence. Optional: a service without it asks nothing. */
  hostRootProblem?(): Promise<string | null>;
  /** Runs `docker <args>`; resolves when it ends (or is killed by the signal, the time limit or the output cap). */
  exec(args: string[], o: ExecOpts): Promise<ExecResult>;
  listContainers(): Promise<Array<{ name: string; worker: string }>>;
  removeContainer(name: string): Promise<void>;
  /** Delay of the second clean-up (a create that raced the first remove). Default 1000 ms. */
  cleanupDelayMs?: number;
  /** How often a blank line keeps a quiet or queued render's connection alive. Default 30 s. */
  heartbeatMs?: number;
}

type Res = http.ServerResponse;

function send(res: Res, status: number, body?: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(status >= 300 && { connection: "close" }) });
  res.end(text);
}

export function createRunnerServer(deps: RunnerDeps): http.Server {
  let tail: Promise<unknown> = Promise.resolve(); // renders run strictly one after the other
  const cleanup = async (name: string): Promise<void> => {
    await deps.removeContainer(name).catch(() => undefined);
    setTimeout(() => void deps.removeContainer(name).catch(() => undefined), deps.cleanupDelayMs ?? 1000).unref();
  };

  async function render(req: http.IncomingMessage, res: Res): Promise<void> {
    let job: RenderJob;
    try {
      const parsed = renderJobSchema.safeParse(JSON.parse((await readBody(req)).toString("utf8")));
      if (!parsed.success) return send(res, 400, { error: "invalid job" });
      job = parsed.data;
    } catch {
      return send(res, 400, { error: "invalid job" });
    }
    let dirs: Awaited<ReturnType<typeof resolveJobDirs>>;
    try {
      dirs = await resolveJobDirs(job, deps.root, deps.hostRoot);
    } catch {
      return send(res, 400, { error: "render folder not allowed" });
    }

    const ac = new AbortController();
    let finished = false;
    // Headers now and a blank line every heartbeat: the worker's fetch gives up after 300 s without headers (a job waiting its turn) or
    // without data (a render that prints nothing while it bundles or draws a heavy frame). The worker skips blank lines.
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
    const beat = setInterval(() => { if (!res.writableEnded) res.write("\n"); }, deps.heartbeatMs ?? 30_000);
    res.on("close", () => { clearInterval(beat); if (!finished) ac.abort(); }); // the worker went away (abort, crash, timeout): stop the render
    const turn = tail.then(async () => {
      if (ac.signal.aborted) return; // left while queued: never runs
      const write = (o: unknown) => { if (!res.writableEnded && !ac.signal.aborted) res.write(JSON.stringify(o) + "\n"); };
      let out: ExecResult & { error?: string };
      try {
        const [host, image] = await Promise.all([deps.hostLimits(), deps.image()]);
        // A job that waited in the queue may find its folders changed: check again right before the run, which narrows (does not close) the
        // window between this check and the daemon resolving the mount paths. The worker is the trust boundary (ADR 0017 §3).
        dirs = await resolveJobDirs(job, deps.root, deps.hostRoot);
        const plan = renderPlan(job, { host, imageRef: image.ref, inDir: dirs.hostIn, outDir: dirs.hostOut });
        out = await deps.exec(plan.args, { onLine: (l) => write({ t: "line", s: l.slice(0, 2000) }), signal: ac.signal, timeoutMs: plan.timeoutMs, maxOutputBytes: plan.maxOutputBytes });
      } catch {
        out = { code: null, signal: null, timedOut: false, truncated: false, error: "The render service could not run the job." };
      } finally {
        await cleanup(job.name);
      }
      clearInterval(beat);
      write({ t: "end", ...out });
      finished = true;
      if (!res.writableEnded) res.end();
    });
    tail = turn.catch(() => undefined);
    await turn;
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req.headers.authorization, deps.token)) return send(res, 401, { error: "unauthorized" }); // before anything is read
        const url = new URL(req.url ?? "/", "http://service");
        const method = req.method ?? "GET";
        const del = /^\/v1\/render\/([^/]+)$/.exec(url.pathname);
        if (url.pathname === "/v1/info") {
          if (method !== "GET") return send(res, 405, { error: "method not allowed" });
          const dockerVersion = await deps.dockerVersion();
          const problem = dockerVersion === null ? null : (await deps.hostRootProblem?.()) ?? null;
          return send(res, 200, { dockerVersion, host: await deps.hostLimits(), image: await deps.image(), ready: dockerVersion !== null && problem === null, ...(problem !== null && { problem }) });
        }
        if (url.pathname === "/v1/containers") {
          if (method !== "GET") return send(res, 405, { error: "method not allowed" });
          return send(res, 200, await deps.listContainers());
        }
        if (url.pathname === "/v1/render") {
          if (method !== "POST") return send(res, 405, { error: "method not allowed" });
          return await render(req, res);
        }
        if (del) {
          if (method !== "DELETE") return send(res, 405, { error: "method not allowed" });
          let name: string;
          try {
            name = decodeURIComponent(del[1]!);
          } catch {
            return send(res, 400, { error: "not a render container" });
          }
          if (!RENDER_NAME.test(name)) return send(res, 400, { error: "not a render container" });
          if (!(await deps.listContainers()).some((c) => c.name === name)) return send(res, 404, { error: "no such render container" });
          await deps.removeContainer(name);
          return send(res, 204);
        }
        return send(res, 404, { error: "not found" });
      } catch {
        if (!res.headersSent) send(res, 503, { error: "unavailable" });
        else res.end();
      }
    })();
  });
  server.requestTimeout = 30_000; // receiving a request (a tiny JSON body); the response of a render may stream for as long as it runs
  server.headersTimeout = 15_000;
  return server;
}
