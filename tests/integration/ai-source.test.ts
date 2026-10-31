import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claudeCodeEnabled,
  claudeCodeUsedToday,
  getClaudeCodeStatus,
  setAiSource,
  takeClaudeCodeSlot,
  testClaudeCodeConnection,
} from "@/server/db/claude-code";
import { copyDefault, createModel, deleteModel, listModels, listRoutes, setRoute } from "@/server/db/llm-models";
import { getSetting, setSetting } from "@/server/db/settings";
import type { SpawnClaude } from "@/server/llm/claude-code";
import { withTestDb, type TestDb } from "../support/db";

// The AI source switch, the Claude Code status row, Test connection and the day-counter trigger (ADR 0014, step 2).
// Every process here is a fake: the real `claude` binary is never started.

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(async () => {
  await db.reset();
  // reset() truncates every table; put back the migration's seed rows this file relies on (owner role: the app may not insert).
  await db.ownerPool.query("insert into claude_code_status (id) values (true)");
  await db.ownerPool.query(
    `insert into model_catalog_defaults (id, provider, model_id, label, base_url, is_free, capabilities) values
     ('claude-code', 'claude_code', 'default', 'Claude Code (this machine)', null, true, '{"structuredOutput":true,"toolUse":false,"vision":false,"nativeWebSearch":false,"contextWindow":200000}')`,
  );
});

const session = { actor: "session" as const };
const caps = { structuredOutput: true, toolUse: true, vision: true, nativeWebSearch: true, contextWindow: 200000 };
const paid = { provider: "anthropic", modelId: "m1", label: "Paid", baseUrl: null, prices: { inputPerMTokMicro: 1_000_000, outputPerMTokMicro: 2_000_000 }, isFree: false, capabilities: caps, enabled: true };

function fakeSpawn(stdout: string, code = 0, stderr = ""): { spawn: SpawnClaude; count: () => number } {
  let n = 0;
  const spawn: SpawnClaude = () => {
    n++;
    const c = Object.assign(new EventEmitter(), { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    c.stdout.end(stdout);
    c.stderr.end(stderr);
    setImmediate(() => c.emit("close", code, null));
    return c;
  };
  return { spawn, count: () => n };
}
const OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } });

describe("AI source switch", () => {
  it("ON creates the Claude Code model from the suggestion, routes the text stages, remembers the old routes and audits; OFF restores", async () => {
    const api = await createModel(db.pool, paid, session);
    for (const s of ["outline", "draft", "build_scene_kit", "build_tsx", "research", "titles"]) await setRoute(db.pool, s, api.id, session);

    const notes = await setAiSource(db.pool, true, session);
    const cc = (await listModels(db.pool)).find((m) => m.provider === "claude_code")!;
    expect(cc).toMatchObject({ enabled: true, isFree: true, prices: null });
    expect(await listRoutes(db.pool)).toEqual({ outline: cc.id, draft: cc.id, build_scene_kit: cc.id, titles: cc.id, comment_replies: cc.id, build_tsx: api.id, research: api.id });
    expect(await getSetting(db.pool, "ai.previous_routes")).toEqual({ outline: api.id, draft: api.id, build_scene_kit: api.id, titles: api.id, comment_replies: null });
    expect(await claudeCodeEnabled(db.pool)).toBe(true);
    expect(notes.join("\n")).toMatch(/Build, Remotion TSX stays on its current model/);
    const audit = await db.pool.query("select detail from audit_log where event = 'ai_source.changed'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].detail).toMatchObject({ source: "claude_code", from: { outline: api.id, comment_replies: null }, to: { outline: cc.id } });

    await expect(setAiSource(db.pool, true, session)).rejects.toThrow(/already/);

    await setAiSource(db.pool, false, session);
    expect(await listRoutes(db.pool)).toEqual({ outline: api.id, draft: api.id, build_scene_kit: api.id, build_tsx: api.id, research: api.id, titles: api.id });
    expect(await getSetting(db.pool, "ai.previous_routes")).toBeNull();
    expect(await claudeCodeEnabled(db.pool)).toBe(false);
    expect((await db.pool.query("select count(*)::int n from audit_log where event = 'ai_source.changed'")).rows[0].n).toBe(2);
    expect((await listModels(db.pool)).filter((m) => m.provider === "claude_code")).toHaveLength(1); // reused, not duplicated
  });

  it("OFF unsets a stage whose remembered model was deleted and says so", async () => {
    const api = await createModel(db.pool, paid, session);
    await setRoute(db.pool, "titles", api.id, session);
    await setAiSource(db.pool, true, session);
    await deleteModel(db.pool, api.id, session); // no longer routed, so it can be deleted
    const notes = await setAiSource(db.pool, false, session);
    expect(await listRoutes(db.pool)).toEqual({});
    expect(notes.join("\n")).toMatch(/Titles and insights: the model it used before was deleted/);
  });

  it("only a session can switch; a disabled Claude Code model is refused; nothing changes on refusal", async () => {
    await expect(setAiSource(db.pool, true, { actor: "token" })).rejects.toThrow(/signed-in session/);
    await createModel(db.pool, { provider: "claude_code", modelId: "default", label: "CC", baseUrl: null, prices: null, isFree: true, capabilities: { ...caps, toolUse: false, vision: false, nativeWebSearch: false }, enabled: false }, session);
    await expect(setAiSource(db.pool, true, session)).rejects.toThrow(/disabled/);
    expect(await listRoutes(db.pool)).toEqual({});
    expect(await claudeCodeEnabled(db.pool)).toBe(false);
  });

  it("the app role cannot slip a remembered set past the schema or a non-session writer", async () => {
    await expect(setSetting(db.pool, "ai.previous_routes", { outline: null }, { actor: "token" })).rejects.toThrow(/logged-in session/);
    await expect(setSetting(db.pool, "ai.previous_routes", { outline: "not-a-uuid" }, session)).rejects.toThrow();
  });

  it("the Claude Code suggestion copies as a free, enabled-able model", async () => {
    const m = await copyDefault(db.pool, "claude-code", session);
    expect(m).toMatchObject({ provider: "claude_code", isFree: true, prices: null, endpointKind: "local" });
  });
});

describe("Claude Code status and Test connection", () => {
  it("the status box reads the switch, cap, today's count and the last stored outcome without starting anything", async () => {
    expect(await getClaudeCodeStatus(db.pool)).toEqual({ enabled: false, switchOn: false, cap: 200, usedToday: 0, last: null });
  });

  it("refuses when switched off, over the cap, or a non-session; passes once, records the outcome, counts toward the cap, and rate-limits", async () => {
    const f = fakeSpawn(OK);
    await expect(testClaudeCodeConnection(db.pool, { kind: "session" }, { spawn: f.spawn })).rejects.toThrow(/switched off/);
    await setSetting(db.pool, "claude_code.enabled", true, session);
    await expect(testClaudeCodeConnection(db.pool, { kind: "token" }, { spawn: f.spawn })).rejects.toThrow(/signed-in session/);

    const r = await testClaudeCodeConnection(db.pool, { kind: "session" }, { spawn: f.spawn });
    expect(r).toEqual({ ok: true, message: "Passed: Claude Code answered." });
    expect(f.count()).toBe(1);
    expect(await claudeCodeUsedToday(db.pool)).toBe(1);
    expect((await getClaudeCodeStatus(db.pool)).last).toMatchObject({ result: "ready", auth: null });

    await expect(testClaudeCodeConnection(db.pool, { kind: "session" }, { spawn: f.spawn })).rejects.toThrow(/a moment ago/);
    expect(f.count()).toBe(1);

    await db.pool.query("update claude_code_status set test_at = now() - interval '11 seconds'");
    await setSetting(db.pool, "claude_code.daily_cap", 1, session);
    await expect(testClaudeCodeConnection(db.pool, { kind: "session" }, { spawn: f.spawn })).rejects.toThrow(/cap is reached/);
    expect(f.count()).toBe(1);
  });

  it("a failed test shows the plain class only, never what the program printed", async () => {
    await setSetting(db.pool, "claude_code.enabled", true, session);
    const f = fakeSpawn("", 1, "Not logged in · secret-ish detail /Users/o/.claude\n");
    const r = await testClaudeCodeConnection(db.pool, { kind: "session" }, { spawn: f.spawn });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not logged in/i);
    expect(r.message).not.toMatch(/secret-ish|\.claude/);
    expect((await getClaudeCodeStatus(db.pool)).last?.result).toBe("not_logged_in");
    const audit = await db.pool.query("select detail from audit_log where event = 'claude_code.tested'");
    expect(audit.rows[0].detail).toEqual({ result: "not_logged_in" });
  });
});

describe("claude_code_daily_calls only counts up", () => {
  it("the app role cannot lower today's count or move the row to another day", async () => {
    await setSetting(db.pool, "claude_code.daily_cap", 5, session);
    expect(await takeClaudeCodeSlot(db.pool)).toBe(true);
    expect(await takeClaudeCodeSlot(db.pool)).toBe(true);
    await expect(db.pool.query("update claude_code_daily_calls set calls = 0")).rejects.toThrow(/only counts up/);
    await expect(db.pool.query("update claude_code_daily_calls set day = day - 1")).rejects.toThrow(/only counts up/);
    expect(await claudeCodeUsedToday(db.pool)).toBe(2);
    expect(await takeClaudeCodeSlot(db.pool)).toBe(true); // counting up still works
    expect(await claudeCodeUsedToday(db.pool)).toBe(3);
  });
});
