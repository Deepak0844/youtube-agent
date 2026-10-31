import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAiSourceForm } from "@/server/core/ai-source";

// The AI source switch and Test connection start (or allow starting) a program on this Mac. requireOwner() runs first; a
// foreign or missing Origin is refused before the database is touched; turning on needs the exact confirmation tick.
const t = vi.hoisted(() => ({ pool: vi.fn(), set: vi.fn(), test: vi.fn(), refresh: vi.fn(), owner: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: t.owner }));
vi.mock("@/lib/auth/action-origin", () => ({ assertActionOrigin: t.origin }));
vi.mock("@/server/db/pool", () => ({ getPool: () => (t.pool(), {}) }));
vi.mock("@/server/db/claude-code", () => ({ setAiSource: t.set, testClaudeCodeConnection: t.test }));
vi.mock("next/cache", () => ({ refresh: t.refresh }));

import { setAiSourceAction, testClaudeCodeAction } from "@/app/(app)/settings/models/actions";

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("parseAiSourceForm", () => {
  it("turning on needs the confirmation tick, exactly 'on'", () => {
    expect(parseAiSourceForm(form({ source: "claude_code", confirm: "on" }))).toEqual({ ok: true, on: true });
    for (const confirm of ["", "true", "yes", "ON", "on "]) expect(parseAiSourceForm(form({ source: "claude_code", confirm })).ok, confirm).toBe(false);
    expect(parseAiSourceForm(form({ source: "claude_code" })).ok).toBe(false);
  });
  it("turning off needs no tick; anything else is refused", () => {
    expect(parseAiSourceForm(form({ source: "api" }))).toEqual({ ok: true, on: false });
    expect(parseAiSourceForm(form({ source: "bedrock", confirm: "on" })).ok).toBe(false);
    expect(parseAiSourceForm(form({})).ok).toBe(false);
  });
});

describe("AI source actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    t.owner.mockResolvedValue({ sessionId: "s1" });
    t.origin.mockResolvedValue(null);
  });

  it("without a session nothing else runs", async () => {
    t.owner.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(setAiSourceAction({}, form({ source: "claude_code", confirm: "on" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(testClaudeCodeAction()).rejects.toThrow("NEXT_REDIRECT");
    for (const fn of [t.origin, t.pool, t.set, t.test, t.refresh]) expect(fn).not.toHaveBeenCalled();
  });

  it("a foreign Origin is refused before the database", async () => {
    t.origin.mockResolvedValue("That request did not come from this page. Nothing was changed.");
    expect((await setAiSourceAction({}, form({ source: "claude_code", confirm: "on" }))).error).toMatch(/did not come from this page/);
    expect((await testClaudeCodeAction()).error).toMatch(/did not come from this page/);
    for (const fn of [t.pool, t.set, t.test]) expect(fn).not.toHaveBeenCalled();
  });

  it("no tick, no switch", async () => {
    expect((await setAiSourceAction({}, form({ source: "claude_code" }))).error).toMatch(/tick/i);
    expect(t.set).not.toHaveBeenCalled();
  });

  it("switches as the session and returns the plain notes", async () => {
    t.set.mockResolvedValue(["Build, Remotion TSX stays on its current model."]);
    const r = await setAiSourceAction({}, form({ source: "claude_code", confirm: "on" }));
    expect(t.set).toHaveBeenCalledWith({}, true, { actor: "session" });
    expect(r).toEqual({ ok: true, notes: ["Build, Remotion TSX stays on its current model."] });
    expect(t.refresh).toHaveBeenCalled();
  });

  it("Test connection runs as the session and shows the fixed sentence only", async () => {
    t.test.mockResolvedValue({ ok: false, message: "Failed: Claude Code is not logged in." });
    const r = await testClaudeCodeAction();
    expect(t.test).toHaveBeenCalledWith({}, { kind: "session" });
    expect(r).toEqual({ ok: false, error: "Failed: Claude Code is not logged in." });
  });
});
