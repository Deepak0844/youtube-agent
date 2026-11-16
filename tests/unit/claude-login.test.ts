import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_RE, createClaudeLogin, loginOutcome, loginUrlFrom } from "@/server/llm/claude-login";
import type { SpawnClaude } from "@/server/llm/claude-code";

const URL_LINE = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
const GOOD = "a".repeat(30) + "#" + "b".repeat(30);

class FakeChild extends EventEmitter {
  pid = 777;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written = "";
  constructor() {
    super();
    this.stdin.on("data", (d) => (this.written += String(d)));
  }
  say(text: string) { this.stdout.write(text); }
  exit(text: string, code = 0) {
    this.stdout.end(text);
    setImmediate(() => this.emit("close", code, null));
  }
}

function setup(over: { timeoutMs?: number } = {}) {
  const children: FakeChild[] = [];
  const spawned: Array<{ cmd: string; args: string[]; opts: Parameters<SpawnClaude>[2] }> = [];
  const kills: Array<[number, string]> = [];
  const spawn: SpawnClaude = (cmd, args, opts) => {
    const c = new FakeChild();
    children.push(c);
    spawned.push({ cmd, args, opts });
    setImmediate(() => c.say(`Opening browser to sign in…\nIf the browser didn't open, visit: ${URL_LINE}\nPaste code here if prompted > `));
    return c;
  };
  const login = createClaudeLogin({
    spawn,
    env: { PATH: "/usr/bin", HOME: "/h", LANG: "C", TERM: "x", USER: "u", ANTHROPIC_API_KEY: "sk-secret", DATABASE_URL: "postgres://x" },
    killGroup: (pid, sig) => { kills.push([pid, sig]); if (sig === "SIGKILL") children.forEach((c) => setImmediate(() => c.emit("close", null, "SIGKILL"))); },
    killGraceMs: 10,
    ...over,
  });
  return { login, children, spawned, kills };
}

afterEach(() => vi.useRealTimers());

describe("claude login runner", () => {
  it("pulls the login URL from the program's output and the outcome from its last words", () => {
    expect(loginUrlFrom(`x\n visit: ${URL_LINE} \nPaste`)).toBe(URL_LINE);
    expect(loginUrlFrom("nothing here")).toBeNull();
    expect(loginOutcome("... Login successful.", 0)).toEqual({ ok: true, message: "Claude is connected." });
    expect(loginOutcome("Login failed: Request failed with status code 400", 1).message).toBe("The code was not accepted. Start again and paste the new code.");
    expect(loginOutcome("", 1).message).toBe("The login did not finish. Start again.");
    expect(CODE_RE.test(GOOD)).toBe(true);
  });

  it("starts claude auth login with no shell, the allowlisted env and an empty temp cwd, and returns the URL once printed", async () => {
    const { login, spawned } = setup();
    const { url } = await login.start();
    expect(url).toBe(URL_LINE);
    const s = spawned[0]!;
    expect([s.cmd, ...s.args]).toEqual(["claude", "auth", "login", "--claudeai"]);
    expect(s.opts.shell).toBe(false);
    expect(Object.keys(s.opts.env).sort()).toEqual(["HOME", "LANG", "PATH", "TERM", "USER"]);
    expect(login.state()).toMatchObject({ phase: "waiting_code", url: URL_LINE });
    login.cancel();
  });

  it("a second start while waiting is refused and the state still holds the same URL", async () => {
    const { login, spawned } = setup();
    await login.start();
    await expect(login.start()).rejects.toThrow("A login is already waiting for its code.");
    expect(spawned).toHaveLength(1);
    expect(login.state()).toMatchObject({ phase: "waiting_code", url: URL_LINE });
    login.cancel();
  });

  it("submit trims whitespace and newlines around the code, then reports connected", async () => {
    const { login, children } = setup();
    await login.start();
    const p = login.submit(`  ${GOOD}\n`);
    await vi.waitFor(() => expect(children[0]!.written).toBe(GOOD + "\n"));
    children[0]!.exit("Login successful.\n");
    expect(await p).toEqual({ ok: true, message: "Claude is connected." });
    expect(login.state()).toMatchObject({ phase: "finished", ok: true });
  });

  it("submit refuses a malformed code without touching the process", async () => {
    const { login, children } = setup();
    await login.start();
    for (const bad of ["", "short", "no hash " + "a".repeat(40), "a".repeat(30) + "#" + "b c".repeat(10)]) {
      expect((await login.submit(bad)).message).toBe("That does not look like a code. Copy the whole code, including the part after #.");
    }
    expect(children[0]!.written).toBe("");
    expect(login.state().phase).toBe("waiting_code");
    login.cancel();
  });

  it("a rejected code is a fixed sentence and never echoes the program's text or the code", async () => {
    const { login, children } = setup();
    await login.start();
    const p = login.submit(GOOD);
    await vi.waitFor(() => expect(children[0]!.written).not.toBe(""));
    children[0]!.exit("Login failed: Request failed with status code 400", 1);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r) + JSON.stringify(login.state())).not.toContain(GOOD);
    expect(JSON.stringify(r)).not.toContain("400");
  });

  it("submit with no login waiting is refused", async () => {
    const { login } = setup();
    expect((await login.submit(GOOD)).message).toBe("No login is waiting. Click Connect again.");
  });

  it("after the timeout the process group is killed and the state says timed out", async () => {
    const { login, kills } = setup({ timeoutMs: 30 });
    await login.start();
    await vi.waitFor(() => expect(login.state()).toMatchObject({ phase: "finished", ok: false, message: "The login timed out. Start again." }));
    expect(kills.map((k) => k[1])).toContain("SIGTERM");
    expect((await login.submit(GOOD)).message).toBe("No login is waiting. Click Connect again.");
  });

  it("cancel kills the child and returns to idle, and a new start works", async () => {
    const { login, kills, spawned } = setup();
    await login.start();
    login.cancel();
    expect(kills[0]).toEqual([777, "SIGTERM"]);
    await vi.waitFor(() => expect(login.state().phase).toBe("idle"));
    await login.start();
    expect(spawned).toHaveLength(2);
    login.cancel();
  });

  it("a spawn that throws leaves no temp folder behind and a later start still works", async () => {
    let cwd = "";
    let first = true;
    const spawn: SpawnClaude = (_c, _a, opts) => {
      cwd = opts.cwd;
      if (first) { first = false; throw new Error("spawn EACCES"); }
      const c = new FakeChild();
      setImmediate(() => c.say(`visit: ${URL_LINE}\n`));
      return c;
    };
    const login = createClaudeLogin({ spawn, env: { PATH: "/usr/bin" }, killGroup: () => {}, killGraceMs: 5 });
    await expect(login.start()).rejects.toThrow("EACCES");
    expect(existsSync(cwd)).toBe(false);
    await expect(login.start()).resolves.toEqual({ url: URL_LINE });
    login.cancel();
  });
});
