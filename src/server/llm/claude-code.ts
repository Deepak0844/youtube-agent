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
// Pictures (vision stages): sent INSIDE the stdin message (`--input-format stream-json`), never as files, so tools stay off and
// nothing on disk is readable; png/jpeg/webp only, at most MAX_IMAGES, each and all together size-capped.
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
  /** Stores the outcome class of a finished call for the status box. Best effort: a failure here never changes the call. */
  record?(o: ClaudeCodeOutcome): Promise<void>;
}
/** What the status box shows. `auth` only when the CLI's JSON names it (a short word); never guessed. */
export type ClaudeCodeResult = "ready" | "not_found" | "not_logged_in" | "limit_reached" | "failed";
export interface ClaudeCodeOutcome { result: ClaudeCodeResult; auth?: string }
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
  /** Refuse at once instead of waiting when this process's queue is busy (the Test connection button). */
  noWait?: boolean;
}

// USER is needed on macOS: without it the program cannot find the login in the keychain and reports "not logged in"
// (measured: `env -i PATH HOME LANG TERM claude auth status` -> loggedIn false; adding USER alone -> true).
const ENV_ALLOW = ["PATH", "HOME", "LANG", "TERM", "USER"] as const;
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

// One Claude Code process at a time PER NODE PROCESS. The web server (Test connection) and the worker (stages) are separate
// processes with separate queues, so a Test can run beside a stage; the daily cap is shared (database).
const queue = createSemaphore(1);

export const minimalEnv = (src: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(ENV_ALLOW.flatMap((k) => (typeof src[k] === "string" ? [[k, src[k]]] : [])));

export function claudeArgs(modelId: string, opts: { images?: boolean } = {}): string[] {
  const args = [
    "-p", ...(opts.images ? ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] : ["--output-format", "json"]),
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
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 3_500_000; // under the API's 5 MB base64 limit per picture
const MAX_IMAGES_TOTAL_BYTES = 16_000_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
export interface PromptImage { mediaType: string; base64: string }

/** The first bytes must match the declared type, or the API refuses the whole call (an unclear outcome instead of a clean refusal). */
function looksLike(mediaType: string, b: Uint8Array): boolean {
  const at = (i: number, xs: number[]) => xs.every((x, k) => b[i + k] === x);
  if (mediaType === "image/png") return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mediaType === "image/jpeg") return at(0, [0xff, 0xd8, 0xff]);
  return at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50]); // RIFF....WEBP
}

/** The prompt as one text, plus any pictures (only from user messages). Anything else (a URL, a PDF, a tool part) is refused. */
export function promptParts(prompt: Prompt): { text: string; images: PromptImage[] } {
  const parts: string[] = [];
  const images: PromptImage[] = [];
  let total = 0;
  for (const m of prompt) {
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content as Array<{ type: string; text?: string; data?: unknown; mediaType?: unknown }>).flatMap((p) => {
            if (p.type === "text" && typeof p.text === "string") return [p.text];
            if (p.type === "file" && m.role === "user" && typeof p.mediaType === "string" && IMAGE_TYPES.has(p.mediaType)) {
              // The SDK wraps bytes as { type: "data", data }; a URL ({ type: "url" }) is never fetched here.
              const d = (p.data as { type?: unknown; data?: unknown } | null)?.type === "data" ? (p.data as { data: unknown }).data : p.data;
              const bytes = d instanceof Uint8Array ? d : typeof d === "string" && /^[A-Za-z0-9+/]+=*$/.test(d) ? Buffer.from(d, "base64") : null;
              if (!bytes || bytes.length === 0) throw refuse("Claude Code here takes pictures as bytes only.");
              if (bytes.length > MAX_IMAGE_BYTES) throw refuse("A picture is too large for Claude Code here.");
              if (!looksLike(p.mediaType, bytes)) throw refuse("A picture's bytes do not match its type (png, jpeg or webp).");
              total += bytes.length;
              if (images.length >= MAX_IMAGES) throw refuse(`Claude Code here takes at most ${MAX_IMAGES} pictures per call.`);
              if (total > MAX_IMAGES_TOTAL_BYTES) throw refuse("The pictures are too large together for one Claude Code call.");
              images.push({ mediaType: p.mediaType, base64: Buffer.from(bytes).toString("base64") });
              return [`(picture ${images.length})`];
            }
            throw refuse("Claude Code here takes text and png, jpeg or webp pictures only.");
          }).join("\n");
    parts.push(`[${m.role}]\n${text}`);
  }
  return { text: parts.join("\n\n"), images };
}

/** stdin for a call with pictures: one stream-json user message, pictures first, then the whole prompt text. */
export function streamInput(text: string, images: readonly PromptImage[]): string {
  const content = [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.base64 } })), { type: "text", text }];
  return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
}

/**
 * stream-json output -> the final `result` event as one JSON text (what interpret reads), or "" when there is none. The billing
 * source (`apiKeySource`) sits in the `system` init event in this mode: it is copied onto the result so the status box keeps it.
 */
export function resultLine(stdout: string): string {
  let result: Record<string, unknown> | undefined;
  let keySource: unknown;
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j?.type === "result") result = j;
      else if (j?.type === "system" && j.subtype === "init" && keySource === undefined) keySource = j.apiKeySource;
    } catch {
      // not a whole event: skip it
    }
  }
  if (!result) return "";
  return JSON.stringify(result.apiKeySource === undefined && keySource !== undefined ? { ...result, apiKeySource: keySource } : result);
}

interface Ran { code: number | null; stdout: string; stderr: string; failed?: "timeout" | "overflow" | "aborted" | "missing" | "error" }

/** 2 minutes for a short answer, up to 10 minutes for a long one (a whole animation file is about 8000 tokens). */
export function callTimeoutMs(maxOutputTokens: number | undefined): number {
  return Math.min(600_000, 120_000 + Math.max(0, maxOutputTokens ?? 0) * 40);
}

async function runOnce(deps: ClaudeCodeDeps, args: string[], input: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Ran> {
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
      timers.push(setTimeout(() => stop("timeout"), timeoutMs));
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
export const LIMIT = /^(?:Claude AI usage limit reached|You(?:'|\u2019)ve (?:hit|reached) your [\w\s-]*limit|API Error: 429\b|API Error: Rate limit)/i;
const LOGIN = /^(?:Invalid API key|Not logged in|Please run \/login|OAuth token (?:has expired|has been revoked)|API Error: 401\b)/i;
/** The text of an ERROR reply that means "log in again". "not authenticated" may sit anywhere in it (the CLI wraps it in other words). Only ever called on an is_error reply, never on an answer. */
export const isLoginProblem = (said: string): boolean => LOGIN.test(said.trimStart()) || /\bnot authenticated\b/i.test(said);
export const LOGIN_MESSAGE = "Claude Code is not logged in on this machine. Run `claude` once and log in.";

const CANCELLED = "The stage was cancelled, so Claude Code was stopped.";
export const BUSY = "Claude Code is busy with another call right now. Nothing was started. Try again in a minute.";

interface Interpreted { text: string; input: number | undefined; output: number | undefined; auth: string | undefined }
function interpret(r: Ran): Interpreted {
  if (r.failed === "aborted") throw refuse(CANCELLED); // $0 and cancelled on purpose: not an unknown outcome
  if (r.failed === "missing") throw refuse("Claude Code is not installed or not on PATH");
  if (r.failed) throw own(new Error(r.failed === "timeout" ? `Claude Code took too long and was stopped. ${MAYBE}` : UNKNOWN));
  let j: { is_error?: unknown; subtype?: unknown; result?: unknown; usage?: Record<string, unknown>; apiKeySource?: unknown } | undefined;
  try {
    const v: unknown = JSON.parse(r.stdout);
    if (typeof v === "object" && v !== null) j = v as typeof j;
  } catch {
    // fall through
  }
  const said = (typeof j?.result === "string" ? j.result : r.stderr).trimStart();
  if (!j || j.is_error === true || j.subtype !== "success" || r.code !== 0) {
    if (LIMIT.test(said)) throw own(new NotProcessedError("Claude Code says the subscription usage limit or rate limit is reached. Try again later.", { status: 429 }));
    if (isLoginProblem(said)) throw own(new NotProcessedError(LOGIN_MESSAGE, { status: 401 }));
    throw own(new Error(UNKNOWN));
  }
  if (typeof j.result !== "string") throw own(new Error(UNKNOWN));
  const n = (k: string) => (typeof j!.usage?.[k] === "number" && Number.isFinite(j!.usage[k]) ? (j!.usage[k] as number) : undefined);
  // Fail closed like the step layer: no input/output count -> undefined -> "provider returned no token usage" (unknown).
  const input = n("input_tokens");
  const auth = typeof j.apiKeySource === "string" && /^[a-z_]{1,24}$/i.test(j.apiKeySource) ? j.apiKeySource : undefined;
  return { auth, text: j.result, input: input === undefined ? undefined : input + (n("cache_creation_input_tokens") ?? 0) + (n("cache_read_input_tokens") ?? 0), output: n("output_tokens") };
}

function outcomeOf(r: Ran, e: unknown): ClaudeCodeResult {
  if (r.failed === "missing") return "not_found";
  const status = e instanceof NotProcessedError ? e.status : undefined;
  return status === 429 ? "limit_reached" : status === 401 ? "not_logged_in" : "failed";
}
async function note(deps: ClaudeCodeDeps, o: ClaudeCodeOutcome): Promise<void> {
  try {
    await deps.gate.record?.(o);
  } catch {
    // the status box is best effort; the call's own result stands
  }
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
      const { text: promptBody, images } = promptParts(options.prompt as Prompt);
      const withImages = images.length > 0;
      const input = withImages ? streamInput(promptBody, images) : promptBody;
      if (!(await deps.gate.enabled())) throw refuse("Claude Code is switched off. Turn it on in Settings > Models.");
      const signal = options.abortSignal;
      // Checked and taken in the same tick (no await between), so two callers cannot both pass.
      if (deps.noWait && queue.busy()) throw refuse(BUSY);
      const r = await queue.run(async () => {
        if (signal?.aborted) throw refuse(CANCELLED); // cancelled while queued: no cap slot used
        if (!(await deps.gate.takeSlot())) throw refuse("daily Claude Code cap reached. It resets at midnight UTC.");
        if (signal?.aborted) throw refuse(CANCELLED);
        const ran = await runOnce(deps, claudeArgs(modelId, { images: withImages }), input, signal, deps.timeoutMs ?? callTimeoutMs(options.maxOutputTokens));
        return withImages ? { ...ran, stdout: resultLine(ran.stdout) } : ran;
      });
      let got: Interpreted;
      try {
        got = interpret(r);
      } catch (e) {
        if (r.failed !== "aborted") await note(deps, { result: outcomeOf(r, e) });
        throw e;
      }
      await note(deps, { result: "ready", ...(got.auth && { auth: got.auth }) });
      const { text, input: inTok, output: outTok } = got;
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
