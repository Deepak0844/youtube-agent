import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { LanguageModel } from "ai";
import { NotProcessedError } from "@/server/core/error-class";
import { KnownFailure } from "@/server/core/paid-call";
import { createSemaphore } from "@/server/core/semaphore";

// Text-only language model backed by the owner's local Claude Code (`claude -p`, subscription login). ADR 0014.
// Rules: no shell (argument array), prompt on stdin only, tools/MCP/hooks/skills off, an empty temp cwd deleted after, a
// minimal env (never ANTHROPIC_*, DATABASE_URL, VAULT* or any app secret), a timeout that kills the process group, a stdout
// cap, one process at a time, and a daily cap taken BEFORE the process starts. Every error leaving here is one of ours
// (fixed sentences; stderr and the answer text are never echoed) and is passed through toSafeModelError unchanged.

export interface ClaudeChild {
  pid?: number | undefined;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(ev: "close", fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: "error", fn: (err: Error) => void): unknown;
}
export interface SpawnClaudeOpts {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  detached: true;
  stdio: ["pipe", "pipe", "pipe"];
}
export type SpawnClaude = (cmd: string, args: string[], opts: SpawnClaudeOpts) => ClaudeChild;

export interface ClaudeCodeGate {
  /** Setting `claude_code.enabled`. */
  enabled(): Promise<boolean>;
  /** Atomically counts one call against today's cap; false when the cap is reached. */
  takeSlot(): Promise<boolean>;
}
export interface ClaudeCodeDeps {
  gate: ClaudeCodeGate;
  /** Tests pass a fake; the default is node's spawn (no shell). */
  spawn?: SpawnClaude;
  /** Signals the whole process group. */
  killGroup?: (pid: number, sig: NodeJS.Signals) => void;
  /** Source of the allow-listed variables (default process.env). */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  maxStdoutBytes?: number;
}

const ENV_ALLOW = ["PATH", "HOME", "LANG", "TERM"] as const;
const BUILTIN_TOOLS = [
  "Agent", "Task", "Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read", "Glob", "Grep", "LS",
  "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "Skill", "SlashCommand", "ExitPlanMode",
];
const SYSTEM_PROMPT = "You are a text generator inside an app. You have no tools. Follow the instructions in the input and reply with only the requested output.";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const MAX_STDERR_BYTES = 4096;
const MAYBE = "It may or may not have used the subscription for this call.";
const UNKNOWN = `Claude Code did not finish cleanly. ${MAYBE}`;

// Our own errors, recognised by toSafeModelError (a WeakSet, so a lookalike object cannot get through).
const OWN = new WeakSet<object>();
const own = <E extends Error>(e: E): E => (OWN.add(e), e);
export const isClaudeCodeError = (e: unknown): e is Error => typeof e === "object" && e !== null && OWN.has(e);
const refuse = (msg: string) => own(new KnownFailure(msg));

const queue = createSemaphore(1); // one Claude Code process at a time, process-wide

export const minimalEnv = (src: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(ENV_ALLOW.flatMap((k) => (typeof src[k] === "string" ? [[k, src[k]]] : [])));

export function claudeArgs(modelId: string): string[] {
  const args = [
    "-p", "--output-format", "json",
    "--tools", "",
    "--disallowedTools", BUILTIN_TOOLS.join(","),
    "--permission-mode", "dontAsk",
    // Only project and local settings, and the cwd is an empty temp dir, so none load: the owner's user settings
    // (apiKeyHelper, env.ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK...) cannot switch billing away from the subscription login.
    "--setting-sources", "project,local",
    "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence",
    "--system-prompt", SYSTEM_PROMPT,
  ];
  if (modelId !== "default") args.push("--model", modelId);
  return args;
}

type Prompt = Array<{ role: string; content: unknown }>;
function promptText(prompt: Prompt): string {
  const parts: string[] = [];
  for (const m of prompt) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string }>).map((p) => {
            if (p.type !== "text" || typeof p.text !== "string") throw refuse("Claude Code here takes text only.");
            return p.text;
          }).join("\n");
    parts.push(`[${m.role}]\n${text}`);
  }
  return parts.join("\n\n");
}

interface Ran { code: number | null; stdout: string; stderr: string; failed?: "timeout" | "overflow" | "aborted" | "missing" | "error" }

async function runOnce(deps: ClaudeCodeDeps, args: string[], input: string, signal: AbortSignal | undefined): Promise<Ran> {
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnClaude);
  const killGroup = deps.killGroup ?? ((pid, sig) => { try { process.kill(-pid, sig); } catch { /* already gone */ } });
  const maxOut = deps.maxStdoutBytes ?? 1024 * 1024;
  const cwd = await mkdtemp(path.join(tmpdir(), "yt-claude-"));
  try {
    return await new Promise<Ran>((resolve) => {
      let out = Buffer.alloc(0);
      let err = "";
      let failed: Ran["failed"];
      let done = false;
      const timers: NodeJS.Timeout[] = [];
      const child = spawn("claude", args, { cwd, env: minimalEnv(deps.env ?? process.env), shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        for (const st of [child.stdin, child.stdout, child.stderr]) st.destroy(); // a grandchild may still hold the pipes
        signal?.removeEventListener("abort", onAbort);
        resolve({ code, stdout: out.toString("utf8"), stderr: err, ...(failed && { failed }) });
      };
      const stop = (why: NonNullable<Ran["failed"]>) => {
        if (failed || done) return;
        failed = why;
        if (child.pid === undefined) return finish(null);
        killGroup(child.pid, "SIGTERM");
        const grace = deps.killGraceMs ?? 5000;
        timers.push(setTimeout(() => {
          killGroup(child.pid!, "SIGKILL");
          // No 'close' after SIGKILL (a failed kill, a grandchild holding the pipes): give up so the queue moves on.
          timers.push(setTimeout(() => finish(null), grace));
        }, grace));
      };
      const onAbort = () => stop("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      timers.push(setTimeout(() => stop("timeout"), deps.timeoutMs ?? 120_000));
      child.stdout.on("data", (d: Buffer) => {
        if (failed) return;
        out = Buffer.concat([out, d]);
        if (out.length > maxOut) stop("overflow");
      });
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < MAX_STDERR_BYTES) err += String(d).slice(0, MAX_STDERR_BYTES - err.length);
      });
      child.on("error", (e: Error & { code?: string }) => {
        failed ??= e.code === "ENOENT" ? "missing" : "error";
        finish(null);
      });
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => {}); // EPIPE when the program exits early: the close handler decides
      child.stdin.end(input);
      if (signal?.aborted) onAbort();
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

// Anchored to the CLI's own error sentences (the start of its `result` field, or of stderr): a stray "429" in text is not a refusal.
const LIMIT = /^(?:Claude AI usage limit reached|You(?:'|\u2019)ve (?:hit|reached) your (?:usage )?limit|API Error: 429\b|API Error: Rate limit)/i;
const LOGIN = /^(?:Invalid API key|Not logged in|Please run \/login|OAuth token (?:has expired|has been revoked)|API Error: 401\b)/i;

const CANCELLED = "The stage was cancelled, so Claude Code was stopped.";

function interpret(r: Ran): { text: string; input: number | undefined; output: number | undefined } {
  if (r.failed === "aborted") throw refuse(CANCELLED); // $0 and cancelled on purpose: not an unknown outcome
  if (r.failed === "missing") throw refuse("Claude Code is not installed or not on PATH");
  if (r.failed) throw own(new Error(r.failed === "timeout" ? `Claude Code took too long and was stopped. ${MAYBE}` : UNKNOWN));
  let j: { is_error?: unknown; subtype?: unknown; result?: unknown; usage?: Record<string, unknown> } | undefined;
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (typeof v === "object" && v !== null) j = v as typeof j;
  } catch {
    // fall through
  }
  const said = (typeof j?.result === "string" ? j.result : r.stderr).trimStart();
  if (!j || j.is_error === true || j.subtype !== "success" || r.code !== 0) {
    if (LIMIT.test(said)) throw own(new NotProcessedError("Claude Code says the subscription usage limit or rate limit is reached. Try again later.", { status: 429 }));
    if (LOGIN.test(said)) throw own(new NotProcessedError("Claude Code is not logged in on this machine. Run `claude` once and log in.", { status: 401 }));
    throw own(new Error(UNKNOWN));
  }
  if (typeof j.result !== "string") throw own(new Error(UNKNOWN));
  const n = (k: string) => (typeof j!.usage?.[k] === "number" && Number.isFinite(j!.usage[k]) ? (j!.usage[k] as number) : undefined);
  // Fail closed like the step layer: no input/output count -> undefined -> "provider returned no token usage" (unknown).
  const input = n("input_tokens");
  return { text: j.result, input: input === undefined ? undefined : input + (n("cache_creation_input_tokens") ?? 0) + (n("cache_read_input_tokens") ?? 0), output: n("output_tokens") };
}

export function createClaudeCodeModel(modelId: string, deps: ClaudeCodeDeps): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "claude_code",
    modelId,
    supportedUrls: {},
    async doGenerate(options) {
      if (!MODEL_ID.test(modelId)) throw refuse("That Claude Code model id is not allowed.");
      if ((options.tools?.length ?? 0) > 0) throw refuse("Claude Code runs with tools off here, so it cannot run tool steps.");
      const input = promptText(options.prompt as Prompt);
      if (!(await deps.gate.enabled())) throw refuse("Claude Code is switched off. Turn it on in Settings > Models.");
      const signal = options.abortSignal;
      const r = await queue.run(async () => {
        if (signal?.aborted) throw refuse(CANCELLED); // cancelled while queued: no cap slot used
        if (!(await deps.gate.takeSlot())) throw refuse("daily Claude Code cap reached. It resets at midnight UTC.");
        if (signal?.aborted) throw refuse(CANCELLED);
        return runOnce(deps, claudeArgs(modelId), input, signal);
      });
      const { text, input: inTok, output: outTok } = interpret(r);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: inTok, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: outTok, text: outTok, reasoning: undefined },
        },
        warnings: [],
      };
    },
    async doStream() {
      throw refuse("Claude Code does not stream here.");
    },
  };
}
