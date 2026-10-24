import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

// Test-only docker helpers for containers that need a network (the render launcher forbids that).
// Every call is execFile with an args array: no shell, no string interpolation into commands.
const exec = promisify(execFile);

export const TEST_LABEL = "ytstudio.test";

// Same lockdown as the render launcher, minus `--network none`.
export const HARDENING = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--tmpfs", "/tmp:rw,size=256m,mode=1777"];
export const AS_UNPRIVILEGED = ["--user", "10001:10001"];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function docker(args: string[], timeoutMs = 60_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec("docker", args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr || e.message };
  }
}

export async function dockerOk(args: string[], timeoutMs?: number): Promise<string> {
  const r = await docker(args, timeoutMs);
  if (r.code !== 0) throw new Error(`docker ${args[0]} failed (${r.code}): ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export interface NetworkOptions {
  subnet?: string;
  label?: string;
}

/** Creates an `--internal` (no default route) bridge network; resolves to its remover. */
export async function createInternalNetwork(name: string, opts: NetworkOptions = {}): Promise<() => Promise<void>> {
  await dockerOk([
    "network", "create", "--internal",
    ...(opts.subnet ? ["--subnet", opts.subnet] : []),
    ...(opts.label ? ["--label", opts.label] : []),
    name,
  ]);
  return async () => {
    await docker(["network", "rm", name]);
  };
}

export interface RunOptions {
  label?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  unprivileged?: boolean; // default true: --user 10001:10001
}

/** Runs a one-shot hardened container attached to `network` only; always removes it. */
export async function runIn(
  network: string,
  image: string,
  command: string[],
  env: Record<string, string> = {},
  opts: RunOptions = {},
): Promise<RunResult> {
  const name = `yt-run-${randomBytes(6).toString("hex")}`;
  const args = [
    "run", "--rm", "--name", name,
    "--network", network,
    ...HARDENING,
    ...(opts.unprivileged === false ? [] : AS_UNPRIVILEGED),
    ...(opts.label ? ["--label", opts.label] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(opts.extraArgs ?? []),
    image,
    ...command,
  ];
  try {
    return await docker(args, opts.timeoutMs ?? 90_000);
  } finally {
    await docker(["rm", "-f", name]); // no-op unless the CLI was killed by the timeout
  }
}

export interface Attachment {
  network: string;
  alias?: string;
}

export interface StartOptions {
  name: string;
  image: string;
  networks: Attachment[]; // first is used at create time, the rest are connected before start
  env?: Record<string, string>;
  command?: string[];
  label?: string;
  unprivileged?: boolean;
  extraArgs?: string[];
}

/** Creates, wires and starts a long-running hardened container. Returns its id. */
export async function startContainer(opts: StartOptions): Promise<string> {
  const [first, ...rest] = opts.networks;
  if (!first) throw new Error("startContainer needs at least one network");
  const id = await dockerOk([
    "create", "--name", opts.name,
    "--network", first.network,
    ...(first.alias ? ["--network-alias", first.alias] : []),
    ...HARDENING,
    ...(opts.unprivileged === false ? [] : AS_UNPRIVILEGED),
    ...(opts.label ? ["--label", opts.label] : []),
    ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(opts.extraArgs ?? []),
    opts.image,
    ...(opts.command ?? []),
  ]);
  for (const att of rest) {
    await dockerOk(["network", "connect", ...(att.alias ? ["--alias", att.alias] : []), att.network, id]);
  }
  await dockerOk(["start", id]);
  return id;
}

export async function containerIp(id: string, network: string): Promise<string> {
  const out = await dockerOk(["inspect", "--format", `{{json .NetworkSettings.Networks}}`, id]);
  const nets = JSON.parse(out) as Record<string, { IPAddress?: string }>;
  const ip = nets[network]?.IPAddress;
  if (!ip) throw new Error(`container ${id} has no address on ${network}`);
  return ip;
}

/** Removes every container and network carrying `label` (best effort, never throws). */
export async function removeLabelled(label: string): Promise<void> {
  const ids = (await docker(["ps", "-aq", "--filter", `label=${label}`])).stdout.split("\n").filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
  const nets = (await docker(["network", "ls", "-q", "--filter", `label=${label}`])).stdout.split("\n").filter(Boolean);
  if (nets.length) await docker(["network", "rm", ...nets]);
}
