import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryError, getPriceRule, listProviders, resolveRoute, setMediaRoute, setProviderEnabled } from "@/server/db/media-registry";
import { finishJob, markJobFailedKnown, markJobUnknown, storeProviderJobId, submitOnce } from "@/server/db/media-jobs";
import { uuidv7 } from "@/server/core/ids";
import type { MediaArtifact } from "@/server/providers/media-types";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(() => db.reset());
afterAll(async () => {
  await db?.stop();
});

const key = () => ({ stageRunId: uuidv7(), step: 0 });
const artifact: MediaArtifact = { path: "a.mp3", bytes: 1, sha256: "x", provenance: { provider: "edge", params: {}, priceMicroUsd: 0, quoted: true } };

describe("media registry", () => {
  it("unpriced_provider_is_refused_before_reserve", async () => {
    await db.pool.query("insert into media_providers (id, kind, label, enabled) values ('p', 'voice', 'P', true)");
    expect(await getPriceRule(db.pool, "p")).toBeNull();
    await db.pool.query(`update media_providers set price = '{"unit":"per_call","microUsd":5}' where id = 'p'`);
    expect(await getPriceRule(db.pool, "p")).toEqual({ unit: "per_call", microUsd: 5 });
    await db.pool.query("update media_providers set enabled = false where id = 'p'");
    expect(await getPriceRule(db.pool, "p")).toBeNull();
  });

  it("submitOnce_is_idempotent_under_10_concurrent_calls", async () => {
    const k = key();
    const rs = await Promise.all(Array.from({ length: 10 }, () => submitOnce(db.pool, k, "edge", "voice", 5)));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.job.id)).size).toBe(1);
    expect((await db.pool.query("select 1 from media_jobs")).rowCount).toBe(1);
  });

  it("provider_job_id_can_be_stored_once_and_only_from_submitting", async () => {
    const { job } = await submitOnce(db.pool, key(), "elevenlabs", "music", 5);
    expect(await storeProviderJobId(db.pool, job.id, "J1")).toBe(true);
    expect(await storeProviderJobId(db.pool, job.id, "J2")).toBe(false);
    const again = await submitOnce(db.pool, { stageRunId: job.stageRunId, step: job.step }, "elevenlabs", "music", 5);
    expect(again).toMatchObject({ created: false, job: { providerJobId: "J1", state: "submitted" } });
    expect(await finishJob(db.pool, job.id, { actual: 4, artifact })).toBe(true);
    expect(await storeProviderJobId(db.pool, job.id, "J3")).toBe(false);
    const other = (await submitOnce(db.pool, key(), "elevenlabs", "music", 5)).job;
    expect(await markJobUnknown(db.pool, other.id)).toBe(true);
    expect(await storeProviderJobId(db.pool, other.id, "J4")).toBe(false);
  });

  it("resolveRoute_prefers_kind_then_format_then_default", async () => {
    const ins = (scope: string, provider: string) => db.pool.query("insert into media_routes (kind, scope, provider) values ('voice', $1, $2)", [scope, provider]);
    await ins("default", "d");
    const args = { format: "short", videoKind: "news" };
    expect(await resolveRoute(db.pool, "voice", args)).toEqual({ provider: "d" });
    await ins("format:short", "f");
    expect(await resolveRoute(db.pool, "voice", args)).toEqual({ provider: "f" });
    await ins("kind:news", "k");
    expect(await resolveRoute(db.pool, "voice", args)).toEqual({ provider: "k" });
    expect(await resolveRoute(db.pool, "voice", { format: "long", videoKind: "x" })).toEqual({ provider: "d" });
  });

  it("no_route_returns_null_not_a_default_provider", async () => {
    await db.pool.query("insert into media_providers (id, kind, label, enabled) values ('p', 'voice', 'P', true)");
    expect(await resolveRoute(db.pool, "voice", { format: "short", videoKind: "news" })).toBeNull();
  });

  it("media_jobs_not_deletable_by_app_role", async () => {
    await submitOnce(db.pool, key(), "edge", "voice", 1);
    await expect(db.pool.query("delete from media_jobs")).rejects.toMatchObject({ code: "42501" });
    await expect(db.pool.query("truncate media_jobs")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("providers page data layer", () => {
  beforeEach(async () => {
    await db.ownerPool.query(`insert into media_providers (id, kind, label, local, price) values
      ('edge', 'voice', 'Edge', false, '{"unit":"free","microUsd":0}'), ('voicestudio', 'voice', 'VoiceStudio', true, '{"unit":"free","microUsd":0}'),
      ('google_tts', 'voice', 'Google', false, '{"unit":"per_1k_chars","microUsd":100}'), ('local_openai', 'voice', 'Local', true, '{}'),
      ('pexels', 'stock', 'Pexels', false, '{"unit":"free","microUsd":0}')`);
  });
  const audits = async (event: string) => (await db.ownerPool.query("select detail from audit_log where event = $1 order by id", [event])).rows.map((r) => r.detail);

  it("enabling_without_key_refused_except_free_and_loopback", async () => {
    await expect(setProviderEnabled(db.pool, "google_tts", true, "session")).rejects.toBeInstanceOf(RegistryError); // paid, no key
    await setProviderEnabled(db.pool, "edge", true, "session"); // free
    await setProviderEnabled(db.pool, "voicestudio", true, "session"); // loopback-local
    await db.ownerPool.query("insert into secrets (name, ciphertext, nonce, key_id, hint) values ('provider.google_tts.api_key', decode(repeat('00', 40), 'hex'), decode(repeat('00', 12), 'hex'), '0123abcd', '')");
    await setProviderEnabled(db.pool, "google_tts", true, "session"); // key now saved
    expect((await listProviders(db.pool)).filter((p) => p.enabled).map((p) => p.id).sort()).toEqual(["edge", "google_tts", "voicestudio"]);
    expect(await audits("provider.toggled")).toEqual([
      { provider: "edge", enabled: true }, { provider: "voicestudio", enabled: true }, { provider: "google_tts", enabled: true },
    ]);
    await expect(setProviderEnabled(db.pool, "edge", false, "token")).rejects.toBeInstanceOf(RegistryError);
  });

  it("disabled_provider_cannot_be_a_route_target", async () => {
    const r = { scope: "default", provider: "edge" };
    await expect(setMediaRoute(db.pool, r, "session")).rejects.toThrow("Switch the provider on first");
    await setProviderEnabled(db.pool, "edge", true, "session");
    await setMediaRoute(db.pool, r, "session");
    expect(await resolveRoute(db.pool, "voice", { format: "short", videoKind: "tsx" })).toEqual({ provider: "edge" });
  });

  it("an unpriced provider, a voice on a non-voice provider and a bad scope are refused", async () => {
    await db.ownerPool.query("update media_providers set enabled = true where id in ('local_openai', 'pexels')");
    await expect(setMediaRoute(db.pool, { scope: "default", provider: "local_openai" }, "session")).rejects.toThrow("price is not set");
    await expect(setMediaRoute(db.pool, { scope: "default", provider: "pexels", voice: "x" }, "session")).rejects.toThrow("Only voice");
    await expect(setMediaRoute(db.pool, { scope: "kind:nope", provider: "edge" }, "session")).rejects.toThrow("Unknown route");
    expect((await db.ownerPool.query("select 1 from media_routes")).rowCount).toBe(0);
  });

  it("route_change_writes_audit_row", async () => {
    await setProviderEnabled(db.pool, "edge", true, "session");
    await setMediaRoute(db.pool, { scope: "kind:tsx", provider: "edge", voice: " en-US-AriaNeural " }, "session");
    expect(await audits("route.changed")).toEqual([{ kind: "voice", scope: "kind:tsx", from: null, to: "edge", voice: "en-US-AriaNeural" }]);
    expect(await resolveRoute(db.pool, "voice", { format: "short", videoKind: "tsx" })).toEqual({ provider: "edge", voice: "en-US-AriaNeural" });
  });
});

describe("media registry price and failed_known", () => {
  it("migration_0031_prices_elevenlabs_voice_only_and_keeps_an_owner_price", async () => {
    const sql = readFileSync("src/server/db/migrations/0031_elevenlabs_price.sql", "utf8");
    await db.ownerPool.query("insert into media_providers (id, kind, label) values ('elevenlabs', 'voice', 'E'), ('elevenlabs_music', 'music', 'M')"); // reset() clears the seeds
    await db.ownerPool.query(sql);
    const price = async (id: string) => (await db.pool.query("select price from media_providers where id = $1", [id])).rows[0].price;
    expect(await price("elevenlabs")).toEqual({ unit: "per_1k_chars", microUsd: 80000 });
    expect(await price("elevenlabs_music")).toEqual({});
    await db.ownerPool.query(`update media_providers set price = '{"unit":"per_1k_chars","microUsd":1}' where id = 'elevenlabs'`);
    await db.ownerPool.query(sql);
    expect(await price("elevenlabs")).toEqual({ unit: "per_1k_chars", microUsd: 1 });
  });

  it("markJobFailedKnown_works_once_from_submitting_and_not_after_done", async () => {
    const { job } = await submitOnce(db.pool, key(), "elevenlabs", "voice", 5);
    expect(await markJobFailedKnown(db.pool, job.id)).toBe(true);
    expect(await markJobFailedKnown(db.pool, job.id)).toBe(false);
    expect((await submitOnce(db.pool, { stageRunId: job.stageRunId, step: job.step }, "elevenlabs", "voice", 5)).job.state).toBe("failed_known");
    const d = await submitOnce(db.pool, key(), "elevenlabs", "voice", 5);
    await finishJob(db.pool, d.job.id, { actual: 5, artifact });
    expect(await markJobFailedKnown(db.pool, d.job.id)).toBe(false);
  });
});
