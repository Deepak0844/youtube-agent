import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPriceRule, resolveRoute } from "@/server/db/media-registry";
import { finishJob, markJobUnknown, storeProviderJobId, submitOnce } from "@/server/db/media-jobs";
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
