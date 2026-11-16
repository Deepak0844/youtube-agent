import { beforeEach, describe, expect, it, vi } from "vitest";

// Connect Claude starts a program (claude auth login) and takes the pasted code. requireOwner() runs first, a foreign Origin is
// refused before anything starts, the code reaches only the login runner, and the probe runs only after an accepted code.
const t = vi.hoisted(() => ({
  owner: vi.fn(), origin: vi.fn(), refresh: vi.fn(), audit: vi.fn(), probe: vi.fn(),
  start: vi.fn(), submit: vi.fn(), cancel: vi.fn(),
}));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: t.owner }));
vi.mock("@/lib/auth/action-origin", () => ({ assertActionOrigin: t.origin }));
vi.mock("@/server/db/pool", () => ({ getPool: () => ({}) }));
vi.mock("@/server/db/audit", () => ({ recordAudit: t.audit }));
vi.mock("@/server/db/claude-code", () => ({ setAiSource: vi.fn(), testClaudeCodeConnection: t.probe }));
vi.mock("@/server/llm/claude-login", () => ({ claudeLogin: () => ({ start: t.start, submit: t.submit, cancel: t.cancel, state: () => ({ phase: "idle" }) }) }));
vi.mock("next/cache", () => ({ refresh: t.refresh }));

import { cancelClaudeLoginAction, startClaudeLoginAction, submitClaudeLoginCodeAction } from "@/app/(app)/settings/models/actions";

const CODE = "a".repeat(30) + "#" + "b".repeat(30);
const form = (code: string) => { const f = new FormData(); f.set("code", code); return f; };

describe("Connect Claude actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    t.owner.mockResolvedValue({ sessionId: "s1" });
    t.origin.mockResolvedValue(null);
    t.start.mockResolvedValue({ url: "https://claude.com/cai/oauth/authorize?x=1" });
  });

  it("without a session nothing else runs", async () => {
    t.owner.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(startClaudeLoginAction()).rejects.toThrow("NEXT_REDIRECT");
    await expect(submitClaudeLoginCodeAction({}, form(CODE))).rejects.toThrow("NEXT_REDIRECT");
    await expect(cancelClaudeLoginAction()).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of [t.origin, t.start, t.submit, t.cancel, t.probe, t.audit]) expect(fn).not.toHaveBeenCalled();
  });

  it("a foreign Origin is refused before the login runner is touched", async () => {
    t.origin.mockResolvedValue("That request did not come from this page. Nothing was changed.");
    expect((await startClaudeLoginAction()).error).toMatch(/did not come from this page/);
    expect((await submitClaudeLoginCodeAction({}, form(CODE))).error).toMatch(/did not come from this page/);
    for (const fn of [t.start, t.submit, t.cancel, t.probe]) expect(fn).not.toHaveBeenCalled();
  });

  it("start begins the login, audits it, and refreshes so the page shows the link", async () => {
    const r = await startClaudeLoginAction();
    expect(r).toEqual({ ok: true, note: "Open the link below and sign in." });
    expect(t.start).toHaveBeenCalledOnce();
    expect(t.audit).toHaveBeenCalledWith({}, "claude_code.login_started", {});
    expect(t.refresh).toHaveBeenCalled();
  });

  it("start while a login is waiting shows that fixed sentence; any other failure is generic and leaks nothing", async () => {
    t.start.mockRejectedValueOnce(new Error("A login is already waiting for its code."));
    expect((await startClaudeLoginAction()).error).toBe("A login is already waiting for its code.");
    t.start.mockRejectedValueOnce(new Error("EACCES: /var/folders/xx/secret-path"));
    expect((await startClaudeLoginAction()).error).toBe("Could not start the login. Try again.");
  });

  it("a rejected code is shown as the fixed sentence and the probe never runs", async () => {
    t.submit.mockResolvedValue({ ok: false, message: "That does not look like a code. Copy the whole code, including the part after #." });
    const r = await submitClaudeLoginCodeAction({}, form("nope"));
    expect(r).toEqual({ ok: false, error: "That does not look like a code. Copy the whole code, including the part after #." });
    expect(t.probe).not.toHaveBeenCalled();
  });

  it("an accepted code runs the probe with the switch ignored; the code reaches only the runner", async () => {
    t.submit.mockResolvedValue({ ok: true, message: "Claude is connected." });
    t.probe.mockResolvedValue({ ok: true, message: "Passed: Claude Code answered." });
    const r = await submitClaudeLoginCodeAction({}, form(`  ${CODE}\n`));
    expect(r).toEqual({ ok: true, note: "Claude is connected. Passed: Claude Code answered." });
    expect(t.submit).toHaveBeenCalledWith(`  ${CODE}\n`); // trimming is the runner's job
    expect(t.probe).toHaveBeenCalledWith({}, { kind: "session" }, {}, { ignoreSwitch: true });
    expect(t.audit).toHaveBeenCalledWith({}, "claude_code.login_submitted", { ok: true });
    expect(JSON.stringify([t.audit.mock.calls, t.probe.mock.calls, t.refresh.mock.calls, r])).not.toContain(CODE);
  });

  it("connected but the check fails: says both, never the program's text", async () => {
    t.submit.mockResolvedValue({ ok: true, message: "Claude is connected." });
    t.probe.mockResolvedValue({ ok: false, message: "Failed: Claude Code is not logged in." });
    expect((await submitClaudeLoginCodeAction({}, form(CODE))).error).toBe("Claude is connected. The check failed: Failed: Claude Code is not logged in.");
  });

  it("cancel stops the login and refreshes", async () => {
    expect(await cancelClaudeLoginAction()).toEqual({ ok: true, note: "Login cancelled." });
    expect(t.cancel).toHaveBeenCalledOnce();
    expect(t.refresh).toHaveBeenCalled();
  });
});
