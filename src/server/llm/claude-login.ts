import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { minimalEnv, type ClaudeChild, type SpawnClaude } from "./claude-code";

// SECURITY CONTROL: the only place the app starts `claude auth login`. Fixed arguments, no shell, the same minimal environment
// as every other claude child, an empty temp cwd. It needs no terminal: the program prints its sign-in link, then reads the
// code the owner pastes from stdin (measured in the compose spike). The pasted code is written to the child's stdin and
// nowhere else: never logged, audited, returned or kept. Every message handed back is a fixed sentence.

export const LOGIN_ARGS = ["auth", "login", "--claudeai"] as const;
/** Shape of the code the sign-in page shows: two url-safe parts joined by #. */
export const CODE_RE = /^[A-Za-z0-9_-]{20,200}#[A-Za-z0-9_-]{20,200}$/;
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const URL_WAIT_MS = 30_000;
const OUT_CAP = 64 * 1024;

export type LoginResult = { ok: boolean; message: string };
export type LoginState =
  | { phase: "idle" }
  | { phase: "waiting_code"; url: string; startedAt: number }
  | { phase: "finished"; ok: boolean; message: string; at: number };

// shortcut: the sign-in host is pinned to claude.com (what 2.1.207 prints); if the program changes host, start() reports "did not print a login link".
export const loginUrlFrom = (stdout: string): string | null => /https:\/\/claude\.com\/\S+/.exec(stdout)?.[0] ?? null;

export function loginOutcome(stdout: string, code: number | null): LoginResult {
  if (code === 0 && /Login successful/i.test(stdout)) return { ok: true, message: "Claude is connected." };
  if (/Login failed/i.test(stdout)) return { ok: false, message: "The code was not accepted. Start again and paste the new code." };
  return { ok: false, message: "The login did not finish. Start again." };
}

const NOT_WAITING: LoginResult = { ok: false, message: "No login is waiting. Click Connect again." };
const BAD_CODE: LoginResult = { ok: false, message: "That does not look like a code. Copy the whole code, including the part after #." };
const TIMED_OUT: LoginResult = { ok: false, message: "The login timed out. Start again." };

export interface ClaudeLoginDeps {
  spawn?: SpawnClaude;
  env?: Record<string, string | undefined>;
  killGroup?: (pid: number, sig: NodeJS.Signals) => void;
  killGraceMs?: number;
  timeoutMs?: number;
  urlWaitMs?: number;
  now?: () => number;
}

interface Run {
  child: ClaudeChild;
  cwd: string;
  stdout: string;
  timers: NodeJS.Timeout[];
  timedOut: boolean;
  done: boolean;
  pending?: Promise<LoginResult>;
  resolvePending?: (r: LoginResult) => void;
  rejectUrl?: (e: Error) => void;
}

export function createClaudeLogin(deps: ClaudeLoginDeps = {}) {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnClaude);
  const killGroup = deps.killGroup ?? ((pid, sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } });
  const grace = deps.killGraceMs ?? 5000;
  const now = deps.now ?? Date.now;
  let st: LoginState = { phase: "idle" };
  let run: Run | undefined;
  let starting = false;

  const kill = (r: Run) => {
    if (r.child.pid === undefined || r.done) return;
    killGroup(r.child.pid, "SIGTERM");
    r.timers.push(setTimeout(() => {
      killGroup(r.child.pid!, "SIGKILL");
      r.timers.push(setTimeout(() => finish(r, null), grace)); // no 'close' after SIGKILL: give up so a new login can start
    }, grace));
  };

  function finish(r: Run, result: LoginResult | null) {
    if (r.done) return;
    r.done = true;
    r.timers.forEach(clearTimeout);
    for (const s of [r.child.stdin, r.child.stdout, r.child.stderr]) s.destroy();
    void rm(r.cwd, { recursive: true, force: true });
    const out = result ?? TIMED_OUT;
    r.rejectUrl?.(new Error("Claude did not print a login link."));
    r.resolvePending?.(out);
    if (run === r) { // a cancelled run was already detached
      run = undefined;
      st = { phase: "finished", ...out, at: now() };
    }
  }

  return {
    /** Starts the login and resolves with the sign-in link once the program prints it. */
    async start(): Promise<{ url: string }> {
      if (starting || run) throw new Error("A login is already waiting for its code.");
      starting = true;
      let r: Run;
      try {
        const cwd = await mkdtemp(path.join(tmpdir(), "yt-claude-login-"));
        let child: ClaudeChild;
        try {
          child = spawn("claude", [...LOGIN_ARGS], { cwd, env: minimalEnv(deps.env ?? process.env), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          await rm(cwd, { recursive: true, force: true });
          throw e;
        }
        r = { child, cwd, stdout: "", timers: [], timedOut: false, done: false };
        run = r;
        st = { phase: "idle" };
      } finally {
        starting = false;
      }
      const run1 = r;
      run1.timers.push(setTimeout(() => { run1.timedOut = true; kill(run1); }, deps.timeoutMs ?? LOGIN_TIMEOUT_MS));
      return new Promise<{ url: string }>((resolve, reject) => {
        run1.rejectUrl = reject;
        run1.timers.push(setTimeout(() => { if (st.phase !== "waiting_code") kill(run1); }, deps.urlWaitMs ?? URL_WAIT_MS));
        run1.child.stdout.on("data", (d: Buffer) => {
          if (run1.stdout.length < OUT_CAP) run1.stdout += String(d).slice(0, OUT_CAP - run1.stdout.length);
          const url = st.phase === "waiting_code" ? null : loginUrlFrom(run1.stdout);
          if (url && run === run1) {
            st = { phase: "waiting_code", url, startedAt: now() };
            run1.rejectUrl = undefined;
            resolve({ url });
          }
        });
        run1.child.stderr.on("data", () => {}); // never kept
        run1.child.on("error", (e: Error & { code?: string }) => finish(run1, { ok: false, message: e.code === "ENOENT" ? "Claude Code is not installed or not on PATH." : "The login could not start." }));
        run1.child.on("close", (code) => finish(run1, run1.timedOut ? TIMED_OUT : loginOutcome(run1.stdout, code)));
        run1.child.stdin.on("error", () => {}); // EPIPE if the program exits early: the close handler decides
      });
    },

    /** Sends the pasted code to the waiting login and resolves with its outcome. A second call returns the first's answer. */
    async submit(raw: string): Promise<LoginResult> {
      const r = run;
      if (!r || st.phase !== "waiting_code") return NOT_WAITING;
      const code = raw.trim();
      if (!CODE_RE.test(code)) return BAD_CODE;
      r.pending ??= new Promise<LoginResult>((res) => {
        r.resolvePending = res;
        r.child.stdin.end(code + "\n");
      });
      return r.pending;
    },

    cancel(): void {
      const r = run;
      if (!r) { st = { phase: "idle" }; return; }
      run = undefined;
      st = { phase: "idle" };
      kill(r);
    },

    state: (): LoginState => st,
  };
}

// One login per web process, kept on globalThis so `next dev` module reloads do not lose a login that is waiting for its code.
const KEY = Symbol.for("ytstudio.claudeLogin");
export function claudeLogin(): ReturnType<typeof createClaudeLogin> {
  const g = globalThis as unknown as Record<symbol, ReturnType<typeof createClaudeLogin> | undefined>;
  return (g[KEY] ??= createClaudeLogin());
}
