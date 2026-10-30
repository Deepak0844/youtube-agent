import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { purgeDueAsset, registerAsset, trashAssets, type RegisterInput } from "@/server/db/assets";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => (db = await withTestDb()));
afterAll(async () => db.stop());
beforeEach(async () => void (await db.pool.query("delete from assets")));

const input = (sha: string): RegisterInput => ({
  kind: "image", originalName: "a.png", mime: "image/png", bytes: 10, sha256: sha.padStart(64, "0"), storageRef: `assets/${sha}/main.png`,
  rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] },
});

describe("purge and revive guard", () => {
  it("purge refuses a row that is live, still in its window, or was revived", async () => {
    const { asset } = await registerAsset(db.pool, input("a"));
    expect(await purgeDueAsset(db.pool, asset.id)).toBeNull();
    await trashAssets(db.pool, [asset.id], false);
    expect(await purgeDueAsset(db.pool, asset.id)).toBeNull();
    expect((await db.pool.query("select 1 from assets where id = $1", [asset.id])).rowCount).toBe(1);
  });
  it("purge removes a due row and returns its files; a job that pointed at it is kept with no asset", async () => {
    const { asset } = await registerAsset(db.pool, input("b"));
    await db.pool.query(
      `insert into ingest_jobs (id, batch_id, status, original_name, contains_person, voice_clone, rights, asset_id)
       values (gen_random_uuid(), gen_random_uuid(), 'done', 'b.png', false, false, '{}', $1)`,
      [asset.id],
    );
    await trashAssets(db.pool, [asset.id], false);
    await db.pool.query("update assets set purge_at = now() - interval '1 second' where id = $1", [asset.id]);
    expect(await purgeDueAsset(db.pool, asset.id)).toEqual({ storageRef: asset.storageRef, derivedRefs: {} });
    const jobs = await db.pool.query("select asset_id from ingest_jobs");
    expect(jobs.rows).toEqual([{ asset_id: null }]);
  });
  it("a duplicate upload cancels a pending deletion but cannot revive a row whose purge is due", async () => {
    const { asset } = await registerAsset(db.pool, input("c"));
    await trashAssets(db.pool, [asset.id], false);
    const again = await registerAsset(db.pool, input("c"));
    expect(again.duplicate).toBe(true);
    expect(again.asset.deletedAt).toBeNull();
    await trashAssets(db.pool, [asset.id], false);
    await db.pool.query("update assets set purge_at = now() - interval '1 second' where id = $1", [asset.id]);
    await expect(registerAsset(db.pool, input("c"))).rejects.toThrow(/being cleaned up/);
    const row = await db.pool.query("select deleted_at from assets where id = $1", [asset.id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });
});
