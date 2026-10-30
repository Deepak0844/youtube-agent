import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "@/server/core/agent-loop";
import { NotProcessedError, classifyError } from "@/server/core/error-class";
import { KnownFailure, runPaidCall, type PaidCallPorts } from "@/server/core/paid-call";
import { priceCardFor, modelInputSchema, type ModelRow } from "@/server/core/llm-catalog";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import { createClaudeCodeModel, type ClaudeCodeDeps, type SpawnClaude } from "@/server/llm/claude-code";

// Every test fakes the process: the real `claude` binary is never started here.

interface FakeRun {
  cmd: string;
  args: string[];
  opts: Parameters<SpawnClaude>[2];
  stdin: string;
  cwdWasEmpty: boolean;
}

type Behaviour = (c: { child: FakeChild; stdinDone: Promise<string> }) => void;
class FakeChild extends EventEmitter {
  pid = 4242;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  finish(stdout: string, code = 0, stderr = "") {
    this.stdout.end(stdout);
    this.stderr.end(stderr);
    setImmediate(() => this.emit("close", code, null));
  }
}

const OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"title":"hi"}', usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 7 } });

function harness(behave: Behaviour = ({ child }) => child.finish(OK), over: Partial<ClaudeCodeDeps> = {}) {
  const runs: FakeRun[] = [];
  const kills: Array<[number, string]> = [];
  let children: FakeChild[] = [];
  let slots = 0;
  const spawn: SpawnClaude = (cmd, args, opts) => {
    const child = new FakeChild();
    children.push(child);
    let buf = "";
    const stdinDone = new Promise<string>((res) => {
      child.stdin.on("data", (d) => (buf += String(d)));
      child.stdin.on("end", () => res(buf));
    });
    const run: FakeRun = { cmd, args, opts, stdin: "", cwdWasEmpty: existsSync(opts.cwd) && readdirSync(opts.cwd).length === 0 };
    runs.push(run);
    void stdinDone.then((s) => (run.stdin = s));
    behave({ child, stdinDone });
    return child;
  };
  const deps: ClaudeCodeDeps = {
    gate: { enabled: async () => true, takeSlot: async () => (slots++, true) },
    spawn,
    killGroup: (pid, sig) => {
      kills.push([pid, sig]);
      if (sig === "SIGKILL") for (const c of children) setImmediate(() => c.emit("close", null, "SIGKILL"));
    },
    env: { PATH: "/usr/bin", HOME: "/Users/o", LANG: "en_US.UTF-8", TERM: "xterm", ANTHROPIC_API_KEY: "sk-ant-x", DATABASE_URL: "postgres://x", VAULT_MASTER_KEY: "v", SECRET: "s" },
    timeoutMs: 200,
    killGraceMs: 20,
    ...over,
  };
  const model = createClaudeCodeModel("default", deps);
  const step = createAiSdkStep(model, [], 1000);
  return { runs, kills, step, deps, slots: () => slots, reset: () => (children = []) };
}

const MSGS: Message[] = [
  { role: "system", content: "Reply with JSON." },
  { role: "user", content: "Make a title about --dangerously-skip-permissions" },
];
const run = (h: ReturnType<typeof harness>, signal = new AbortController().signal) => h.step(MSGS, "key-1", signal);
const caught = async (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as Error);

describe("claude code adapter", () => {
  it("parses a successful answer and its token usage", async () => {
    const h = harness();
    const r = await run(h);
    expect(r.text).toBe('{"title":"hi"}');
    expect(r.usage).toEqual({ inputTokens: 15, outputTokens: 7 });
    expect(h.slots()).toBe(1);
  });

  it("starts claude with tools off, no shell, the prompt on stdin, a minimal env and an empty temp cwd", async () => {
    const h = harness();
    await run(h);
    const [r] = h.runs;
    expect(r!.cmd).toBe("claude");
    expect(r!.opts.shell).toBe(false);
    expect(r!.opts.detached).toBe(true);
    const a = r!.args;
    expect(a.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    for (const t of ["Bash", "Edit", "Write", "Read", "WebFetch", "WebSearch"]) expect(a[a.indexOf("--disallowedTools") + 1]!.split(",")).toContain(t);
    expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    for (const f of ["--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence"]) expect(a).toContain(f);
    expect(a).not.toContain("--model"); // "default" means no --model
    expect(a.join(" ")).not.toContain("Make a title");
    expect(r!.stdin).toContain("Make a title about --dangerously-skip-permissions");
    expect(r!.stdin).toContain("Reply with JSON.");
    expect(Object.keys(r!.opts.env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM"]);
    expect(r!.cwdWasEmpty).toBe(true);
    expect(existsSync(r!.opts.cwd)).toBe(false); // deleted afterwards
  });

  it("passes --model only for a configured plain id and refuses an id that looks like a flag", async () => {
    const h = harness();
    const step = createAiSdkStep(createClaudeCodeModel("sonnet", h.deps), [], 100);
    await step(MSGS, "k", new AbortController().signal);
    expect(h.runs[0]!.args.slice(-2)).toEqual(["--model", "sonnet"]);
    const bad = createAiSdkStep(createClaudeCodeModel("--dangerously-skip-permissions", h.deps), [], 100);
    const e = await caught(bad(MSGS, "k", new AbortController().signal));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(h.runs).toHaveLength(1);
  });

  it("timeout kills the process group (TERM then KILL) and is an unknown outcome", async () => {
    const h = harness(() => {}, { timeoutMs: 20 }); // never answers, ignores SIGTERM
    const e = await caught(run(h));
    expect(h.kills).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]); // killGroup signals the whole group (-pid)
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e)).toBe("unknown");
    expect(e.message).toMatch(/may or may not/);
  });

  it("usage limit is a clear rejection the retry policy waits on", async () => {
    const h = harness(({ child }) => child.finish(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1761955200" }), 1));
    const e = await caught(run(h));
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(classifyError(e)).toBe("transient");
    expect(e.message).not.toContain("1761955200");
  });

  it("not logged in is a clear permanent rejection", async () => {
    const h = harness(({ child }) => child.finish(JSON.stringify({ type: "result", is_error: true, result: "Invalid API key · Please run /login" }), 1));
    const e = await caught(run(h));
    expect(e).toBeInstanceOf(NotProcessedError);
    expect(classifyError(e)).toBe("permanent");
    expect(e.message).toMatch(/not logged in/i);
  });

  it("a missing binary is a clear KnownFailure", async () => {
    const h = harness(({ child }) => setImmediate(() => child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))));
    const e = await caught(run(h));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toBe("Claude Code is not installed or not on PATH");
  });

  it("refuses when switched off, before taking a slot or starting anything", async () => {
    let took = 0;
    const h = harness(undefined, { gate: { enabled: async () => false, takeSlot: async () => (took++, true) } });
    const e = await caught(run(h));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toMatch(/switched off/);
    expect(took).toBe(0);
    expect(h.runs).toHaveLength(0);
  });

  it("refuses over the daily cap without starting anything", async () => {
    const h = harness(undefined, { gate: { enabled: async () => true, takeSlot: async () => false } });
    const e = await caught(run(h));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(e.message).toMatch(/daily Claude Code cap reached/);
    expect(classifyError(e)).not.toBe("transient");
    expect(h.runs).toHaveLength(0);
  });

  it("stdout over the cap kills the process group and is an unknown outcome", async () => {
    const h = harness(({ child }) => child.stdout.write("x".repeat(2000)), { maxStdoutBytes: 1000 });
    const e = await caught(run(h));
    expect(h.kills[0]).toEqual([4242, "SIGTERM"]);
    expect(e).not.toBeInstanceOf(KnownFailure);
    expect(classifyError(e)).toBe("unknown");
  });

  it("garbled output after sending is an unknown outcome and stderr never leaks", async () => {
    const h = harness(({ child }) => child.finish("not json", 0, "secret-ish stderr text"));
    const e = await caught(run(h));
    expect(classifyError(e)).toBe("unknown");
    expect(e.message).not.toContain("secret-ish");
  });

  it("refuses tool declarations (tools stay off)", async () => {
    const h = harness();
    const step = createAiSdkStep(createClaudeCodeModel("default", h.deps), [{ name: "search", description: "d", inputSchema: { type: "object" } }], 100);
    const e = await caught(step(MSGS, "k", new AbortController().signal));
    expect(e).toBeInstanceOf(KnownFailure);
    expect(h.runs).toHaveLength(0);
  });

  it("runs one process at a time", async () => {
    const pending: FakeChild[] = [];
    const h = harness(({ child }) => void pending.push(child));
    const a = run(h);
    const b = run(h);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.runs).toHaveLength(1);
    pending[0]!.finish(OK);
    await a;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.runs).toHaveLength(2);
    pending[1]!.finish(OK);
    await b;
  });

  it("a replayed paid step does not start claude or count again", async () => {
    const h = harness();
    const stored = new Map<string, unknown>();
    const ports: PaidCallPorts = {
      async reserve(_c, a) {
        const k = `${a.stepIndex}`;
        return stored.has(k) ? { kind: "existing", status: "done", result: stored.get(k), intentId: k, reservedMicroUsd: 0 } : { kind: "new", intentId: k };
      },
      async settle(id, a) {
        stored.set(id, a.result);
      },
      failKnown: async () => {},
      markUnknown: async () => {},
      markStageNeedsDecision: async () => {},
      warn: () => {},
    };
    const ctx = { claim: { stageRunId: "r", fence: 1, workerId: "w" }, stepIndex: 0, toolCallIndex: 0, reserveMicroUsd: 0, budgetScopes: [], kind: "paid" as const };
    const call = async (key: string) => ({ result: await h.step(MSGS, key, new AbortController().signal), actualMicroUsd: 0 });
    await runPaidCall(ports, ctx, call);
    await runPaidCall(ports, ctx, call);
    expect(h.runs).toHaveLength(1);
    expect(h.slots()).toBe(1);
  });
});

describe("claude code in the catalog", () => {
  const row: ModelRow = {
    id: "00000000-0000-4000-8000-000000000009",
    provider: "claude_code",
    modelId: "default",
    label: "Claude Code",
    baseUrl: null,
    prices: null,
    isFree: true,
    capabilities: { structuredOutput: true, toolUse: false, vision: false, nativeWebSearch: false, contextWindow: 200000 },
    enabled: true,
    endpointKind: "local",
  };
  it("is free without a price card", () => {
    expect(priceCardFor(row, [])?.inputPerMTokMicro).toBe(0);
    expect(priceCardFor({ ...row, provider: "anthropic" }, [])).toBeUndefined();
  });
  it("can be saved free with no base URL and no prices, and only that way", () => {
    const base = { provider: "claude_code", modelId: "default", label: "Claude Code", baseUrl: null, prices: null, isFree: true, capabilities: row.capabilities, enabled: true };
    expect(modelInputSchema([]).safeParse(base).success).toBe(true);
    expect(modelInputSchema([]).safeParse({ ...base, isFree: false }).success).toBe(false);
    expect(modelInputSchema([]).safeParse({ ...base, baseUrl: "https://example.com" }).success).toBe(false);
  });
});
