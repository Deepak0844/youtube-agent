import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { argsHash, commandLabelOf, readProcInfo } from "./proc-info";

// SECURITY CONTROL: the one way the worker runs host tools (ffprobe/ffmpeg now; whisper.cpp and others later). The child:
//  - is started with an args array and shell:false, so metacharacters in arguments are literal;
//  - sees only an allow-listed environment (default PATH), so no vault key, DATABASE_URL or API key can reach it;
//  - runs in its own process group, and abort/timeout/over-cap kills the whole group (SIGTERM, grace, SIGKILL);
//  - has stdout+stderr capped in total, and delivers output line by line (long lines are split, never buffered whole);
//  - is recorded in a registry (child_processes) so a SIGKILLed worker's orphans are found and killed at the next boot.
// It runs in the worker process but every wait is async, so the heartbeat keeps ticking while a child burns CPU.

export interface ChildSpec {
  command: string;
  args: string[];
  cwd: string;
  cwdRoot?: string; // when set, cwd must resolve (symlinks followed) to this folder or inside it
  envAllow?: string[]; // names copied from the worker's environment; default ["PATH"]
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  onLine?(line: string): void;
  stageRunId: string;
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/** Where live children are recorded. Registration failing is fatal for that child (fail closed: never run untracked). */
export interface ChildRegistry {
  register(row: { pid: number; startedAtEpoch: number; commandLabel: string; argsSha256: string; stageRunId: string }): Promise<void>;
  unregister(pid: number, startedAtEpoch: number): Promise<void>;
}

export interface RunChildDeps {
  registry?: ChildRegistry;
  env?: Record<string, string | undefined>; // test hook: where allow-listed values come from (default process.env)
  killGraceMs?: number; // SIGTERM to SIGKILL gap (default 2000)
  registryTimeoutMs?: number; // longest runChild waits on the registry (register/unregister); a stalled DB cannot hang it (default 5000)
}

export class ChildError extends Error {}

const SECRET_NAME = /key|secret|token|passw|credential|database|redis|auth|vault|cookie|session/i;
// Names that change what a program loads or runs, refused even when a caller asks for them.
const DANGEROUS_NAME = /^(LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|IFS|PYTHON.*|PERL5?LIB|PERL5?OPT|RUBYOPT|RUBYLIB|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS)$/i;
const MAX_LINE_CHARS = 64 * 1024;

/** Builds the child's environment: exactly the allow-listed names that are set. HOME is never passed unless explicitly allowed. */
export function buildChildEnv(allow: readonly string[] | undefined, src: Record<string, string | undefined> = process.env): Record<string, string> {
  const names = allow ?? ["PATH"];
  const out: Record<string, string> = {};
  for (const n of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw new ChildError(`Invalid environment variable name: ${n}`);
    if (DANGEROUS_NAME.test(n)) throw new ChildError(`Refusing to pass ${n} to a child process: it can change which code the child loads.`);
    if (SECRET_NAME.test(n)) throw new ChildError(`Refusing to pass ${n} to a child process: the name looks like a secret.`);
    const v = src[n];
    if (v !== undefined) out[n] = v;
  }
  return out;
}

function killGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig); // the child leads its own group (detached), so -pid reaches grandchildren too
  } catch {
    /* already gone */
  }
}

export async function runChild(spec: ChildSpec, deps: RunChildDeps = {}): Promise<ChildResult> {
  if (!spec.command || spec.command.includes("\0") || spec.args.some((a) => a.includes("\0"))) {
    throw new ChildError("Child command or arguments contain a NUL character.");
  }
  if (!path.isAbsolute(spec.cwd)) throw new ChildError("Child working directory must be an absolute path.");
  const env = buildChildEnv(spec.envAllow, deps.env);
  if (spec.cwdRoot !== undefined) {
    let root: string;
    let cwd: string;
    try {
      [root, cwd] = await Promise.all([realpath(spec.cwdRoot), realpath(spec.cwd)]);
    } catch {
      throw new ChildError("Child working directory does not exist.");
    }
    if (cwd !== root && !cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
      throw new ChildError("Child working directory is outside the allowed folder.");
    }
  }
  if (spec.signal.aborted) return { code: null, signal: null, truncated: false, timedOut: false, aborted: true };

  const grace = deps.killGraceMs ?? 2000;
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: env as NodeJS.ProcessEnv,
    shell: false,
    detached: true, // own process group: pgid === pid
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  // spawn failure (ENOENT, EACCES, bad cwd) arrives as an 'error' event; turn it into a plain rejection.
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once("error", (e: NodeJS.ErrnoException) => {
      reject(new ChildError(e.code === "ENOENT" ? `${path.basename(spec.command)} is not installed or the folder is missing.` : `Could not start ${path.basename(spec.command)}: ${e.message}`));
    });
  });
  spawnFailed.catch(() => undefined);
  const pid = child.pid;
  if (pid === undefined) return spawnFailed;

  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let killed = false;
  let killTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;

  const stopGroup = (): void => {
    if (killed) return;
    killed = true;
    killGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), grace);
  };

  const onAbort = (): void => {
    aborted = true;
    stopGroup();
  };
  spec.signal.addEventListener("abort", onAbort, { once: true });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    stopGroup();
  }, spec.timeoutMs);

  let total = 0;
  const emit = (line: string): void => {
    if (!spec.onLine) return;
    try {
      spec.onLine(line);
    } catch {
      /* a broken log sink must not break the child runner */
    }
  };
  const attach = (stream: NodeJS.ReadableStream): void => {
    const dec = new StringDecoder("utf8");
    let buf = "";
    const flush = (final: boolean): void => {
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        emit(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
      while (buf.length > MAX_LINE_CHARS) {
        emit(buf.slice(0, MAX_LINE_CHARS));
        buf = buf.slice(MAX_LINE_CHARS);
      }
      if (final && buf) {
        emit(buf);
        buf = "";
      }
    };
    stream.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = spec.maxOutputBytes - total;
      if (chunk.length > room) {
        truncated = true;
        if (room > 0) buf += dec.write(chunk.subarray(0, room));
        total = spec.maxOutputBytes;
        flush(true);
        stopGroup();
        return;
      }
      total += chunk.length;
      buf += dec.write(chunk);
      flush(false);
    });
    stream.on("end", () => {
      buf += dec.end();
      flush(true);
    });
    stream.on("error", () => undefined);
  };
  attach(child.stdout!);
  attach(child.stderr!);

  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    };
    child.once("close", (code, signal) => finish(code, signal));
    // If the child exits but a grandchild keeps the pipes open, 'close' never fires: after a grace period kill the group and let go.
    child.once("exit", (code, signal) => {
      hardTimer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, grace + 500);
    });
    child.once("error", () => finish(null, null));
  });

  // Registration runs beside the child, never in front of it: a stalled database can neither delay the child's own
  // timeout/abort handling nor hang this call. If the child is not recorded in time (or recording fails) it is killed.
  const regTimeout = deps.registryTimeoutMs ?? 5000;
  let startedAtEpoch = 0;
  let registered = false;
  let regError: unknown;
  let regTimedOut = false;
  const bounded = <T>(p: Promise<T>): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, regTimeout);
      p.then(
        () => (clearTimeout(t), resolve()),
        () => (clearTimeout(t), resolve()),
      );
    });
  const track = (async (): Promise<void> => {
    if (!deps.registry) return;
    const info = await readProcInfo(pid);
    if (!info) return; // already exited, nothing to track
    startedAtEpoch = info.startedAtEpoch;
    await deps.registry.register({ pid, startedAtEpoch, commandLabel: commandLabelOf(info.args), argsSha256: argsHash(info.args), stageRunId: spec.stageRunId });
    registered = true;
  })();
  const regGuard = setTimeout(() => {
    regTimedOut = true;
    killGroup(pid, "SIGKILL"); // never leave an untracked child running
  }, regTimeout);
  const tracked = track.then(
    () => clearTimeout(regGuard),
    (e: unknown) => {
      clearTimeout(regGuard);
      regError = e;
      killGroup(pid, "SIGKILL");
    },
  );
  try {
    const r = await Promise.race([done, spawnFailed]);
    await bounded(tracked); // let an in-flight register settle first so unregister cannot run before it
    if (regError !== undefined) throw regError;
    if (regTimedOut && !registered) throw new ChildError("Could not record the child process in time; it was stopped.");
    return { code: r.code, signal: r.signal, truncated, timedOut, aborted };
  } finally {
    clearTimeout(regGuard);
    clearTimeout(timeoutTimer);
    clearTimeout(killTimer);
    clearTimeout(hardTimer);
    spec.signal.removeEventListener("abort", onAbort);
    // Whatever way the run ended, anything left in the group (a grandchild that outlived its parent) dies with it.
    killGroup(pid, "SIGKILL");
    if (registered && deps.registry) await bounded(deps.registry.unregister(pid, startedAtEpoch));
  }
}
