import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSetting } from "@/server/db/settings";
import { createVoiceFor } from "@/worker/stages/voice-for";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(() => db.reset());

const args = { lang: "en", format: "short", kind: "scene_kit", budgetScopes: [] as string[] } as const;
async function route(provider: string, price: string) {
  await db.ownerPool.query("insert into media_providers (id, kind, label, enabled, price) values ($1, 'voice', $1, true, $2::jsonb) on conflict (id) do update set enabled = true, price = $2::jsonb", [provider, price]);
  await db.ownerPool.query("insert into media_routes (kind, scope, provider, voice) values ('voice', 'default', $1, 'v1') on conflict (kind, scope) do update set provider = $1, voice = 'v1'", [provider]);
}
const set = (key: string, value: unknown) => setSetting(db.pool, key, value, { actor: "session" });
const pick = () => createVoiceFor(db.pool, () => { throw new Error("no ring"); })(args).catch((e) => { throw new Error(String((e as Error).message)); });

describe("voice settings for Azure, local and VoiceStudio", () => {
  it("a local server with no address is refused, and with one it is built", async () => {
    await route("local_openai", '{"unit":"free","microUsd":0}');
    await expect(pick()).rejects.toThrow(/address/);
    await set("voice.local_url", "http://127.0.0.1:8880");
    expect((await pick()).provider.capability.id).toBe("openai-compatible");
  });
  it("VoiceStudio is built from its address", async () => {
    await route("voicestudio", '{"unit":"free","microUsd":0}');
    await expect(pick()).rejects.toThrow(/address/);
    await set("voice.voicestudio_url", "http://127.0.0.1:8881");
    expect((await pick()).provider.capability.id).toBe("voicestudio");
  });
  it("Azure needs its region (after the key)", async () => {
    await route("azure_tts", '{"unit":"per_1k_chars","microUsd":16000}');
    await expect(pick()).rejects.toThrow(/key/);
  });
});
