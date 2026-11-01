import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { makeKeyring } from "@/server/core/vault-crypto";
import { putSecret } from "@/server/db/vault";
import { setSetting } from "@/server/db/settings";
import { createVoiceFor } from "@/worker/stages/voice-for";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => { db = await withTestDb(); });
afterAll(async () => { await db?.stop(); });
beforeEach(() => db.reset());

const args = { lang: "en", format: "short", kind: "scene_kit", budgetScopes: ["video:v1"] as string[] } as const;
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
  it("Azure needs its key, then its region, then a voice", async () => {
    await route("azure_tts", '{"unit":"per_1k_chars","microUsd":16000}');
    await expect(pick()).rejects.toThrow(/key/);
    const ring = makeKeyring(randomBytes(32).toString("base64"));
    await putSecret(db.pool, ring, "provider.azure_speech.api_key", "a".repeat(32));
    const noRing = () => ring;
    await expect(createVoiceFor(db.pool, noRing)(args)).rejects.toThrow(/region/);
    await set("voice.azure_region", "westeurope");
    await db.ownerPool.query("update media_routes set voice = null");
    await expect(createVoiceFor(db.pool, noRing)(args)).rejects.toThrow(/Azure voice/);
    expect(Number((await db.pool.query("select count(*) n from spend_intents")).rows[0].n)).toBe(0);
  });
  it("a local server with no voice chosen, or a bad address, is refused", async () => {
    await route("local_openai", '{"unit":"free","microUsd":0}');
    await set("voice.local_url", "not a url");
    await expect(pick()).rejects.toThrow(/not a valid URL/);
    await set("voice.local_url", "http://127.0.0.1:8880");
    await db.ownerPool.query("update media_routes set voice = null");
    await expect(pick()).rejects.toThrow(/choose a voice/);
  });
  it("a saved key is never sent over plain http to another computer by the local server", async () => {
    await route("local_openai", '{"unit":"free","microUsd":0}');
    const ring = makeKeyring(randomBytes(32).toString("base64"));
    await putSecret(db.pool, ring, "provider.local_voice.api_key", "k".repeat(12));
    await set("voice.local_url", "http://voice.example.com:8880");
    await expect(createVoiceFor(db.pool, () => ring)(args)).rejects.toThrow(/plain http/);
    await set("voice.local_url", "https://voice.example.com:8880");
    expect((await createVoiceFor(db.pool, () => ring)(args)).provider.capability.id).toBe("openai-compatible");
  });
  it("VoiceStudio on another computer without a key is refused before any spend", async () => {
    await route("voicestudio", '{"unit":"free","microUsd":0}');
    await set("voice.voicestudio_url", "http://voice.example.com:8881");
    await expect(pick()).rejects.toThrow(/key is required/);
  });
});
