import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeEnabled, claudeCodeUsedToday, takeClaudeCodeSlot } from "@/server/db/claude-code";
import { createModel, getModel, setRoute } from "@/server/db/llm-models";
import { priceCardFor } from "@/server/core/llm-catalog";
import { setSetting } from "@/server/db/settings";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { claudeCodeGate } from "@/server/db/claude-code";
import { createAiSdkStep } from "@/server/llm/ai-sdk-step";
import type { SpawnClaude } from "@/server/llm/claude-code";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { buildModel } from "@/server/llm/model-factory";
import type { ModelRow } from "@/server/core/llm-catalog";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(() => db.reset());

const set = (key: string, value: unknown) => setSetting(db.pool, key, value, { actor: "session" });
const caps = { structuredOutput: true, toolUse: false, vision: false, nativeWebSearch: false, contextWindow: 200000 };

describe("Claude Code switch and daily cap (ADR 0014)", () => {
  it("is off by default and only a session turns it on", async () => {
    expect(await claudeCodeEnabled(db.pool)).toBe(false);
    await expect(setSetting(db.pool, "claude_code.enabled", true, { actor: "token" })).rejects.toThrow(/logged-in session/);
    await set("claude_code.enabled", true);
    expect(await claudeCodeEnabled(db.pool)).toBe(true);
  });

  it("counts calls and refuses past the cap, even when taken at the same time", async () => {
    await set("claude_code.daily_cap", 3);
    const got = await Promise.all(Array.from({ length: 6 }, () => takeClaudeCodeSlot(db.pool)));
    expect(got.filter(Boolean)).toHaveLength(3);
    expect(await claudeCodeUsedToday(db.pool)).toBe(3);
    expect(await takeClaudeCodeSlot(db.pool)).toBe(false);
  });

  it("a claude_code model saves free with no key or address and can be routed to a text stage", async () => {
    const m = await createModel(db.pool, { provider: "claude_code", modelId: "default", label: "Claude Code", baseUrl: null, prices: null, isFree: true, capabilities: caps, enabled: true }, { actor: "session" });
    expect(m.endpointKind).toBe("local");
    expect(priceCardFor((await getModel(db.pool, m.id))!, [])?.outputPerMTokMicro).toBe(0);
    await setRoute(db.pool, "outline", m.id, { actor: "session" });
  });

  it("the app role cannot delete or truncate the counter", async () => {
    expect(await takeClaudeCodeSlot(db.pool)).toBe(true);
    await expect(db.pool.query("delete from claude_code_daily_calls")).rejects.toThrow(/permission denied/);
    await expect(db.pool.query("truncate claude_code_daily_calls")).rejects.toThrow(/permission denied/);
    expect(await claudeCodeUsedToday(db.pool)).toBe(1);
  });

  it("a model built through the factory obeys the stored switch and cap (fake process, never the real binary)", async () => {
    const row: ModelRow = { id: "00000000-0000-4000-8000-0000000000cc", provider: "claude_code", modelId: "default", label: "Claude Code", baseUrl: null, prices: null, isFree: true, capabilities: caps, enabled: true, endpointKind: "local" };
    const msgs = [{ role: "user" as const, content: "hi" }];
    const sig = () => new AbortController().signal;
    // Production wiring: switched off by default, refused before anything starts.
    const prod = await defaultModelDeps(db.pool, () => { throw new Error("no ring"); });
    await expect(createAiSdkStep(prod.buildModel(row, async () => null), [], 100)(msgs, "k", sig())).rejects.toThrow(/switched off/);
    let spawned = 0;
    const spawn: SpawnClaude = () => {
      spawned++;
      const c = Object.assign(new EventEmitter(), { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      c.stdout.end(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }));
      c.stderr.end();
      setImmediate(() => c.emit("close", 0, null));
      return c;
    };
    const step = createAiSdkStep(buildModel(row, async () => null, { localServices: [], claudeCode: { gate: claudeCodeGate(db.pool), spawn } }), [], 100);
    await set("claude_code.enabled", true);
    await set("claude_code.daily_cap", 1);
    expect((await step(msgs, "k1", sig())).text).toBe("ok");
    await expect(step(msgs, "k2", sig())).rejects.toThrow(/daily Claude Code cap reached/);
    expect(spawned).toBe(1);
  });
});
