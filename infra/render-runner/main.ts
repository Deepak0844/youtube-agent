import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JOB_LABEL, daemonLimits } from "../../src/server/render/runner";
import { NAME_PREFIX, parseRenderContainers, RENDER_NAME, WORKER_LABEL } from "../../src/server/render/render-job";
import { runChild } from "../../src/server/render/child";
import { loadRunnerConfig } from "./config";
import { createRunnerServer } from "./server";

const loaded = loadRunnerConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(`render-runner: ${loaded.error}\n`);
  process.exit(1);
}
const cfg = loaded.config;

const run = promisify(execFile);
const env = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" } as unknown as NodeJS.ProcessEnv; // PATH only: no DOCKER_HOST, no secrets
const docker = async (args: string[]): Promise<string> => (await run("docker", args, { env, timeout: 30_000 })).stdout;

const server = createRunnerServer({
  token: cfg.token,
  root: cfg.root,
  hostRoot: cfg.hostRoot,
  hostLimits: daemonLimits,
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

server.listen(cfg.port, "0.0.0.0", () => process.stdout.write(`render-runner listening on :${cfg.port}\n`));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
