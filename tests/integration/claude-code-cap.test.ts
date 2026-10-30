import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeEnabled, claudeCodeUsedToday, takeClaudeCodeSlot } from "@/server/db/claude-code";
import { createModel, getModel, setRoute } from "@/server/db/llm-models";
import { priceCardFor } from "@/server/core/llm-catalog";
import { setSetting } from "@/server/db/settings";
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
});
