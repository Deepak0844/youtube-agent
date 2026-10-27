import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeKeyring } from "@/server/core/vault-crypto";
import { createModel } from "@/server/db/llm-models";
import { testModel } from "@/server/db/llm-test";
import { putSecret } from "@/server/db/vault";
import { defaultModelDeps } from "@/server/llm/default-deps";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
const ring = makeKeyring(randomBytes(32).toString("base64"));
const KEY = "sk-ant-api03-REALVAULTKEY-NEVER-LEAK-0123456789abcdef";
const session = { kind: "session" } as const;
const caps = { structuredOutput: true, toolUse: true, vision: false, nativeWebSearch: false, contextWindow: 128000 };
const paid = { provider: "anthropic", modelId: "m-1", label: "Paid one", baseUrl: null, prices: { inputPerMTokMicro: 3_000_000, outputPerMTokMicro: 15_000_000 }, isFree: false, capabilities: caps, enabled: true };

beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  await db.ownerPool.query(await readFile("src/server/db/migrations/0005_settings.sql", "utf8"));
  await db.ownerPool.query(await readFile("src/server/db/migrations/0018_llm_test_eval.sql", "utf8"));
});

// A fake HTTP layer that records what the model factory sends and answers like Anthropic.
function fakeFetch(seen: Array<{ url: string; key: string | null }>, body: unknown = { id: "x", type: "message", role: "assistant", model: "m-1", content: [{ type: "text", text: '{"ok":true}' }], stop_reason: "end_turn", usage: { input_tokens: 30, output_tokens: 5 } }, status = 200) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
}

describe("default model dependencies (vault + real factory)", () => {
  it("test_button_end_to_end_reads_the_vault_per_call_and_sends_the_key_only_in_the_header", async () => {
    const id = (await createModel(db.pool, paid, { actor: "session" })).id;
    await putSecret(db.pool, ring, "provider.anthropic.api_key", KEY);
    const seen: Array<{ url: string; key: string | null }> = [];
    const deps = await defaultModelDeps(db.pool, () => ring, { fetch: fakeFetch(seen) });
    const r = await testModel(db.pool, id, session, { ...deps, cooldownMs: 0 });
    expect(r).toMatchObject({ ok: true, structuredOutput: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ url: "https://api.anthropic.com/v1/messages", key: KEY });
    const all = JSON.stringify([
      r,
      (await db.ownerPool.query("select * from audit_log")).rows,
      (await db.ownerPool.query("select * from spend_intents")).rows,
      (await db.ownerPool.query("select * from stage_runs")).rows,
      (await db.ownerPool.query("select id, last_test from llm_models")).rows,
    ]);
    expect(all).not.toContain("REALVAULTKEY");
  });

  it("missing_key_is_a_plain_free_failure_and_nothing_is_sent", async () => {
    const id = (await createModel(db.pool, paid, { actor: "session" })).id;
    const seen: Array<{ url: string; key: string | null }> = [];
    const deps = await defaultModelDeps(db.pool, () => ring, { fetch: fakeFetch(seen) });
    const r = await testModel(db.pool, id, session, { ...deps, cooldownMs: 0 });
    expect(r).toMatchObject({ ok: false, costMicroUsd: 0 });
    expect(r.message).toMatch(/^No key saved for Anthropic/);
    expect(seen).toEqual([]);
    expect((await db.ownerPool.query("select status from spend_intents")).rows[0].status).toBe("failed_known");
  });

  it("a_vault_that_cannot_open_the_key_gives_a_plain_failure_without_the_cause", async () => {
    const id = (await createModel(db.pool, paid, { actor: "session" })).id;
    await putSecret(db.pool, ring, "provider.anthropic.api_key", KEY);
    const otherRing = makeKeyring(randomBytes(32).toString("base64"));
    const deps = await defaultModelDeps(db.pool, () => otherRing, { fetch: fakeFetch([]) });
    const r = await testModel(db.pool, id, session, { ...deps, cooldownMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Could not read the key for Anthropic/);
  });

  it("a_401_whose_body_echoes_the_key_never_reaches_any_store", async () => {
    const id = (await createModel(db.pool, paid, { actor: "session" })).id;
    await putSecret(db.pool, ring, "provider.anthropic.api_key", KEY);
    const echo = { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } };
    const deps = await defaultModelDeps(db.pool, () => ring, { fetch: fakeFetch([], echo, 401) });
    const r = await testModel(db.pool, id, session, { ...deps, cooldownMs: 0 });
    expect(r).toMatchObject({ ok: false, costMicroUsd: 0 });
    expect(r.message).toMatch(/401/);
    const all = JSON.stringify([
      r,
      (await db.ownerPool.query("select * from audit_log")).rows,
      (await db.ownerPool.query("select * from spend_intents")).rows,
      (await db.ownerPool.query("select * from stage_runs")).rows,
      (await db.ownerPool.query("select id, last_test from llm_models")).rows,
    ]);
    expect(all).not.toContain("REALVAULTKEY");
  });

  it("local_model_gets_no_key_read_at_all", async () => {
    await db.ownerPool.query("update settings set value = '[\"localhost:11434\"]'::jsonb where key = 'network.local_services'");
    const id = (await createModel(db.pool, { provider: "ollama", modelId: "q", label: "L", baseUrl: "http://localhost:11434/v1", prices: null, isFree: true, capabilities: caps, enabled: true }, { actor: "session" })).id;
    let keyReads = 0;
    const deps = await defaultModelDeps(db.pool, () => ((keyReads++, ring)), {
      fetch: (async () =>
        new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "q", choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } }), { status: 200, headers: { "content-type": "application/json" } })) as typeof globalThis.fetch,
    });
    const r = await testModel(db.pool, id, session, { ...deps, cooldownMs: 0 });
    expect(r).toMatchObject({ ok: true, costMicroUsd: 0 });
    expect(keyReads).toBe(0);
  });
});
