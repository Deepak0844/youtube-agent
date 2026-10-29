import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { listAssets, listTags, registerAsset, restoreAsset, setKeep, tagAssets, trashAssets, type RegisterInput } from "@/server/db/assets";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => (db = await withTestDb()));
afterAll(async () => db.stop());
beforeEach(async () => void (await db.pool.query("delete from assets")));

let n = 0;
const make = async (o: Partial<RegisterInput> = {}) =>
  (
    await registerAsset(db.pool, {
      kind: "image", originalName: `p${n}.png`, mime: "image/png", bytes: 10, sha256: (++n).toString(16).padStart(64, "0"),
      storageRef: `assets/j${n}/main.png`, rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] }, ...o,
    })
  ).asset;

describe("asset library SQL", () => {
  it("lists live assets, filtered by kind, tag, source and name", async () => {
    await make({ tags: ["cat"], originalName: "Kitten.png" });
    await make({ kind: "audio", mime: "audio/wav", originalName: "tone.wav", source: "stock" });
    expect((await listAssets(db.pool, {})).length).toBe(2);
    expect((await listAssets(db.pool, { kind: "audio" })).map((a) => a.originalName)).toEqual(["tone.wav"]);
    expect((await listAssets(db.pool, { tag: "cat" })).length).toBe(1);
    expect((await listAssets(db.pool, { source: "stock" })).length).toBe(1);
    expect((await listAssets(db.pool, { q: "kitt" })).length).toBe(1);
    expect(await listTags(db.pool)).toEqual(["cat"]);
  });
  it("delete moves to trash for 7 days; restore works until purge_at", async () => {
    const a = await make();
    const r = await trashAssets(db.pool, [a.id], false);
    expect(r.trashed).toEqual([a.id]);
    expect(await listAssets(db.pool, {})).toHaveLength(0);
    const [t] = await listAssets(db.pool, { trash: true });
    expect(t!.purgeAt!.getTime() - t!.deletedAt!.getTime()).toBeGreaterThan(6.9 * 86400_000);
    expect(await restoreAsset(db.pool, a.id)).toBe(true);
    expect(await listAssets(db.pool, {})).toHaveLength(1);
    await trashAssets(db.pool, [a.id], false);
    await db.pool.query("update assets set purge_at = now() - interval '1 second' where id = $1", [a.id]);
    expect(await restoreAsset(db.pool, a.id)).toBe(false);
  });
  it("Keep blocks delete until confirmed", async () => {
    const a = await make();
    await setKeep(db.pool, a.id, true);
    const r = await trashAssets(db.pool, [a.id], false);
    expect(r).toEqual({ trashed: [], keptBlocked: [a.id] });
    expect((await trashAssets(db.pool, [a.id], true)).trashed).toEqual([a.id]);
  });
  it("tags are unioned", async () => {
    const a = await make({ tags: ["a"] });
    await tagAssets(db.pool, [a.id], ["b", "a"]);
    expect((await listAssets(db.pool, {}))[0]!.tags.sort()).toEqual(["a", "b"]);
  });
});
