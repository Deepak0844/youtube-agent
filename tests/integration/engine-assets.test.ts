import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { addAudioItem } from "@/server/db/audio-library";
import { registerAsset } from "@/server/db/assets";
import { engineAssetFile, engineListAssets } from "@/server/db/engine-assets";
import { withTestDb, type TestDb } from "../support/db";

// The engine's list_assets / fetch_asset read the app's libraries: sound effects and music (audio_items, licence text required)
// and pictures and clips (assets, a rights attestation required). Queries are parameterised; files resolve inside storage only.

let db: TestDb;
let root: string;
const SHA = (c: string) => c.repeat(64);
beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "engine-assets-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  mkdirSync(path.join(root, "audio", "sfx"), { recursive: true });
  mkdirSync(path.join(root, "assets", "up"), { recursive: true });
  writeFileSync(path.join(root, "audio", "sfx", "whoosh.wav"), "w");
  writeFileSync(path.join(root, "assets", "up", "lab.png"), "p");
  await addAudioItem(db.pool, { kind: "sfx", name: "whoosh 100% fast", tags: ["swoosh"], source: "shipped", licence: "CC0", provenance: {}, filePath: "sfx/whoosh.wav", sha256: SHA("a"), durationS: 1.2, meanLufs: null, peakDbfs: null });
  await addAudioItem(db.pool, { kind: "music", name: "calm bed", tags: ["calm"], source: "shipped", licence: "Pixabay licence", provenance: {}, filePath: "music/calm.mp3", sha256: SHA("b"), durationS: 60, meanLufs: null, peakDbfs: null });
  await registerAsset(db.pool, { kind: "image", originalName: "lab photo.png", mime: "image/png", bytes: 1, sha256: SHA("c"), storageRef: "assets/up/lab.png", tags: ["science"], source: "upload", rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] } });
  // a row without any rights cannot exist at all (assets_rights_check); the listing filters on attestations as a second guard
  await expect(db.pool.query(`insert into assets (kind, original_name, mime, bytes, sha256, storage_ref, tags, source, rights) values ('image','no rights.png','image/png',1,$1,'assets/up/lab.png','{}','upload','{"attestations":[]}')`, [SHA("d")])).rejects.toThrow(/assets_rights_check/);
  // a stored path that climbs out of storage: never resolved
  await db.pool.query(`insert into assets (kind, original_name, mime, bytes, sha256, storage_ref, tags, source, rights) values ('image','escape.png','image/png',1,$1,'../../etc/passwd','{}','upload',$2::jsonb)`, [SHA("e"), JSON.stringify({ attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] })]);
});

describe("engine assets", () => {
  it("lists_only_safe_licence_assets_with_a_parameterised_query", async () => {
    const sfx = await engineListAssets(db.pool, "sfx");
    expect(sfx).toEqual([{ id: expect.stringMatching(/^audio:/), kind: "sfx", name: "whoosh 100% fast", licence: "CC0", durationS: 1.2 }]);
    expect((await engineListAssets(db.pool, "music", "calm")).map((a) => a.name)).toEqual(["calm bed"]);
    const images = await engineListAssets(db.pool, "image");
    expect(images.map((a) => a.name).sort()).toEqual(["escape.png", "lab photo.png"]);
    expect(images.every((a) => a.id.startsWith("asset:") && a.licence === RIGHTS_TEXT)).toBe(true);
    expect((await engineListAssets(db.pool, "image", "science")).map((a) => a.name)).toEqual(["lab photo.png"]); // a tag matches too
    // quotes and LIKE wildcards are data, not SQL or patterns
    expect(await engineListAssets(db.pool, "sfx", "x' or '1'='1")).toEqual([]);
    expect((await engineListAssets(db.pool, "sfx", "100%")).map((a) => a.name)).toEqual(["whoosh 100% fast"]);
    expect(await engineListAssets(db.pool, "sfx", "_")).toEqual([]); // an unescaped _ would match every name
    expect(await engineListAssets(db.pool, "video")).toEqual([]);
  });

  it("asset_file_is_inside_storage", async () => {
    const [sfx] = await engineListAssets(db.pool, "sfx");
    expect(await engineAssetFile(db.pool, root, sfx!.id)).toBe(path.join(root, "audio", "sfx", "whoosh.wav"));
    const images = await engineListAssets(db.pool, "image");
    expect(await engineAssetFile(db.pool, root, images.find((a) => a.name === "lab photo.png")!.id)).toBe(path.join(root, "assets", "up", "lab.png"));
    expect(await engineAssetFile(db.pool, root, images.find((a) => a.name === "escape.png")!.id)).toBeNull();
    const [music] = await engineListAssets(db.pool, "music");
    expect(await engineAssetFile(db.pool, root, music!.id)).toBeNull(); // listed, but its file is missing
    for (const bad of ["", "audio:", "audio:nope", "asset:../x", "x:00000000-0000-0000-0000-000000000000", "audio:00000000-0000-0000-0000-000000000000"]) {
      expect(await engineAssetFile(db.pool, root, bad), bad).toBeNull();
    }
  });
});
