import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { StageStep } from "@/server/core/stage-runner";

// Polls a condition on DB/Redis/child state with a bounded deadline. Never a fixed sleep used as synchronisation.
export async function waitFor<T>(
  probe: () => Promise<T | false | null | undefined> | T | false | null | undefined,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

// Awaits a signal with a bounded deadline, so a missed signal fails fast with a label instead of hanging the test.
export async function within<T>(p: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for: ${label}`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const ONE_STEP: StageStep[] = [{ stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 1000, budgetScopes: ["g"], kind: "paid" }];

export interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const SCRIPT = fileURLToPath(new URL("./worker-process.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export interface ChildWorker {
  child: ChildProcess;
  waitMarker(marker: string, timeoutMs?: number): Promise<void>;
  kill9(): Promise<void>;
  output(): string;
}

const live = new Set<ChildProcess>();

// Spawns the worker-process child (single node process, tsx loaded with --import).
export function spawnChildWorker(env: Record<string, string>): ChildWorker {
  const child = spawn(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  live.add(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  void exited.then(() => live.delete(child));
  return {
    child,
    output: () => out + err,
    async waitMarker(marker, timeoutMs = 30_000) {
      await waitFor(() => {
        if (out.split("\n").includes(marker)) return true;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`worker-process exited before ${marker}:\n${out}${err}`);
        }
        return false;
      }, `child marker ${marker}`, timeoutMs);
    },
    async kill9() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}

// afterEach safety net: no test may leave a child behind.
export async function killAllChildren(): Promise<void> {
  await Promise.all(
    [...live].map(
      (c) =>
        new Promise<void>((r) => {
          if (c.exitCode !== null || c.signalCode !== null) return r();
          c.once("exit", () => r());
          c.kill("SIGKILL");
        }),
    ),
  );
}
