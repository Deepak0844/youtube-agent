import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// SECURITY CONTROL: the only place untrusted render code is started. Every lock is applied here and
// callers cannot loosen them. docker is invoked via execFile with an args array (never a shell string).
const run = promisify(execFile);

export const RENDER_IMAGE = "ytstudio-render:dev";
export const JOB_LABEL = "ytstudio.job";
const LOG_CAP = 1024 * 1024;
const JOB_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;
const DEFAULT_LIMITS = { cpus: 4, memoryMb: 4096, pids: 512 };

export interface HostLimits {
  cpus: number;
  memoryMb: number;
}

let hostLimitsCache: Promise<HostLimits> | undefined;

// What the Docker daemon can actually give (cached per process). Falls back to this machine if docker info fails.
export function daemonLimits(): Promise<HostLimits> {
  hostLimitsCache ??= (async (): Promise<HostLimits> => {
    const fallback: HostLimits = { cpus: availableParallelism(), memoryMb: Math.floor(totalmem() / 1048576) };
    try {
      const { stdout } = await run("docker", ["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { timeout: 10_000 });
      const [ncpu = Number.NaN, mem = Number.NaN] = stdout.trim().split(/\s+/).map(Number);
      return {
        cpus: Number.isFinite(ncpu) && ncpu > 0 ? ncpu : fallback.cpus,
        memoryMb: Number.isFinite(mem) && mem > 0 ? Math.floor(mem / 1048576) : fallback.memoryMb,
      };
    } catch {
      return fallback;
    }
  })();
  return hostLimitsCache;
}

export interface RenderJobSpec {
  jobId: string;
  storageRoot: string; // absolute; only jobDir (rw) and <storageRoot>/assets (ro) are mounted, at the same path
  jobDir: string; // absolute, inside storageRoot
  command: string[];
  limits?: { cpus: number; memoryMb: number; pids: number };
  image?: string;
  tmpfs?: string[]; // extra container paths to mount as tmpfs
  signal?: AbortSignal; // abort at any time: cancels a start in flight and removes the container
}

export interface RunningJob {
  containerId: string;
  wait(): Promise<{ exitCode: number; logs: string }>;
  kill(): Promise<void>;
}

function assertJobId(jobId: string): void {
  if (typeof jobId !== "string" || !JOB_ID_RE.test(jobId)) throw new Error("invalid jobId");
}

function assertMountable(p: string, what: string): void {
  if (typeof p !== "string" || !path.isAbsolute(p)) throw new Error(`${what} must be an absolute path`);
  if (p.includes(":") || p.includes(",") || p.includes("\0") || /[\r\n]/.test(p)) throw new Error(`${what} contains forbidden characters`);
  if (path.normalize(p) !== p || p === "/") throw new Error(`${what} must be normalised and not the root`);
}

/** A mount source must exist, be a directory and be its own realpath (no symlink on the way). docker -v must never create it. */
export async function assertRealDir(p: string, what: string): Promise<void> {
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    throw new Error(`${what} does not exist`);
  }
  if (real !== p) throw new Error(`${what} must be a real (symlink-free) path`);
  if (!(await fs.stat(p)).isDirectory()) throw new Error(`${what} must be a directory`);
}

const RESERVED_TMPFS = ["/proc", "/sys", "/dev", "/tmp"];

function assertTmpfs(t: string): void {
  if (typeof t !== "string" || !path.isAbsolute(t) || t === "/" || /[:,\0\r\n]/.test(t) || path.normalize(t) !== t) {
    throw new Error(`invalid tmpfs path: ${JSON.stringify(t)}`);
  }
  if (RESERVED_TMPFS.some((r) => t === r || t.startsWith(r + "/"))) throw new Error(`reserved tmpfs path: ${t}`);
}

export const RENDER_USER = "10001:10001"; // the image's `render` user (infra/Dockerfile.render)

/**
 * The sandbox flags every render container gets (ADR 0003), shared by this runner and the render stage's container
 * renderer. Limits only ever go down: never above the request, never above what the daemon has (10% memory margin).
 */
export function lockFlags(limits: { cpus: number; memoryMb: number; pids: number }, host: HostLimits): string[] {
  for (const v of [limits.cpus, limits.memoryMb, limits.pids]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error("invalid limits");
  }
  const cpus = Math.min(limits.cpus, host.cpus);
  const memoryMb = Math.ceil(Math.min(limits.memoryMb, Math.floor(host.memoryMb * 0.9)));
  return [
    "--pull=never",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777",
    "--shm-size=256m",
    "--user", RENDER_USER,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(Math.ceil(limits.pids)),
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,
    "--cpus", String(cpus),
  ];
}

export async function buildDockerArgs(spec: RenderJobSpec, host?: HostLimits): Promise<string[]> {
  assertJobId(spec.jobId);
  assertMountable(spec.storageRoot, "storageRoot");
  assertMountable(spec.jobDir, "jobDir");
  if (!spec.jobDir.startsWith(spec.storageRoot + path.sep)) throw new Error("jobDir must be inside storageRoot");
  if (spec.jobDir.slice(spec.storageRoot.length + 1).split(path.sep).length < 2) {
    throw new Error("jobDir must be at least two levels below storageRoot");
  }
  const assetsDir = path.join(spec.storageRoot, "assets");
  if (spec.jobDir === assetsDir || spec.jobDir.startsWith(assetsDir + path.sep) || assetsDir.startsWith(spec.jobDir + path.sep)) {
    throw new Error("jobDir must not overlap the shared assets directory");
  }
  await assertRealDir(spec.storageRoot, "storageRoot");
  await assertRealDir(spec.jobDir, "jobDir");

  const image = spec.image ?? RENDER_IMAGE;
  if (!IMAGE_RE.test(image)) throw new Error("invalid image name");
  const limits = spec.limits ?? DEFAULT_LIMITS;
  for (const v of [limits.cpus, limits.memoryMb, limits.pids]) {
    if (!Number.isFinite(v) || v <= 0) throw new Error("invalid limits");
  }
  const available = host ?? (await daemonLimits());
  if (!Array.isArray(spec.command) || spec.command.length === 0 || spec.command.some((c) => typeof c !== "string")) {
    throw new Error("command must be a non-empty string array");
  }
  const extraTmpfs = spec.tmpfs ?? [];
  extraTmpfs.forEach(assertTmpfs);

  const assets = path.join(spec.storageRoot, "assets");
  const hasAssets = await assertRealDir(assets, "assets").then(
    () => true,
    () => false,
  );

  return [
    "run",
    "-d",
    "--rm=false",
    ...lockFlags(limits, available),
    ...extraTmpfs.flatMap((t) => ["--tmpfs", `${t}:rw,size=64m`]),
    "--log-driver", "local",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=2",
    "--label", `${JOB_LABEL}=${spec.jobId}`,
    "-v", `${spec.jobDir}:${spec.jobDir}:rw`,
    ...(hasAssets ? ["-v", `${assets}:${assets}:ro`] : []),
    image,
    ...spec.command,
  ];
}

function collectLogs(containerId: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["logs", containerId], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (b: Buffer) => {
      chunks.push(b);
      size += b.length;
      for (let head = chunks[0]; head && size - head.length >= LOG_CAP; head = chunks[0]) size -= chunks.shift()?.length ?? 0;
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(Buffer.concat(chunks).subarray(-LOG_CAP).toString("utf8")));
  });
}

export async function startRenderJob(spec: RenderJobSpec): Promise<RunningJob> {
  const args = await buildDockerArgs(spec);
  const { signal } = spec;
  signal?.throwIfAborted();
  let containerId: string;
  try {
    const { stdout } = await run("docker", args, { timeout: 60_000, signal });
    containerId = stdout.trim();
    if (!/^[0-9a-f]{12,64}$/.test(containerId)) throw new Error("docker run did not return a container id");
    signal?.throwIfAborted();
  } catch (err) {
    // The daemon may still create/start the container after the CLI died: sweep now and once more shortly after.
    await removeJobContainers(spec.jobId).catch(() => undefined);
    setTimeout(() => void removeJobContainers(spec.jobId).catch(() => undefined), 1000).unref();
    throw err;
  }

  let killed: Promise<void> | undefined;
  let waited: Promise<{ exitCode: number; logs: string }> | undefined;

  const removeQuietly = () => run("docker", ["rm", "-f", containerId], { timeout: 30_000 }).then(() => undefined, () => undefined);

  const job: RunningJob = {
    containerId,
    kill() {
      killed ??= (async () => {
        await run("docker", ["kill", containerId], { timeout: 10_000 }).catch(() => undefined);
        await removeQuietly();
      })();
      return killed;
    },
    wait() {
      waited ??= (async () => {
        let exitCode = 137;
        let logs = "";
        try {
          const r = await run("docker", ["wait", containerId]);
          exitCode = Number.parseInt(r.stdout.trim(), 10);
          if (Number.isNaN(exitCode)) exitCode = 137;
        } catch {
          // container already removed by kill()
        }
        if (killed) {
          await killed;
          return { exitCode: exitCode || 137, logs };
        }
        logs = await collectLogs(containerId);
        await removeQuietly();
        return { exitCode, logs };
      })();
      return waited;
    },
  };
  signal?.addEventListener("abort", () => void job.kill(), { once: true });
  return job;
}

// For the reconciler: remove every container (running or not) labelled with this job.
export async function removeJobContainers(jobId: string): Promise<void> {
  assertJobId(jobId);
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=${JOB_LABEL}=${jobId}`]);
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length) await run("docker", ["rm", "-f", ...ids], { timeout: 30_000 });
}
