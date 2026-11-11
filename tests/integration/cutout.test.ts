import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { DEFAULT_CUTOUT, type CutoutOptions } from "@/server/core/cutout";
import { getAsset, registerAsset } from "@/server/db/assets";
import { CutoutRefused, makeCutout } from "@/server/db/cutouts";
import { runChild } from "@/server/render/child";
import type { Matte } from "@/server/render/cutout";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "cutout-it-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const ingest = { runChild };
const svg = (bg: string) => `<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="240" fill="${bg}"/><ellipse cx="160" cy="130" rx="60" ry="75" fill="#c0392b"/><circle cx="160" cy="70" r="28" fill="#f1c27d"/></svg>`;

/** A library picture whose file really is on disk under the storage root. */
async function picture(bg = "#ffffff", name = "fox.png"): Promise<string> {
  const rel = `assets/seed-${Math.random().toString(36).slice(2)}`;
  mkdirSync(path.join(root, rel), { recursive: true });
  const buf = await sharp(Buffer.from(svg(bg))).png().toBuffer();
  writeFileSync(path.join(root, rel, "main.png"), buf);
  const r = await registerAsset(db.pool, {
    kind: "image", originalName: name, mime: "image/png", bytes: buf.length, width: 320, height: 240, sha256: [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join(""),
    storageRef: `${rel}/main.png`, tags: ["fox"], caption: "A fox", source: "upload", rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] },
  } as never);
  return r.asset.id;
}
/** A stand-in for the model: keeps only pixels that are not near-white (like a perfect remover on this art), same size as the input. */
const fakeMatte: Matte = async (inPath, outPath) => {
  const { data, info } = await sharp(inPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) if (data[i]! > 240 && data[i + 1]! > 240 && data[i + 2]! > 240) data[i + 3] = 0;
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(outPath);
};
const run = (id: string, o: Partial<CutoutOptions> = {}, matte: Matte = fakeMatte) => makeCutout(db.pool, { root, ingest, matte }, id, { ...DEFAULT_CUTOUT, ...o });

describe("makeCutout", () => {
  it("saves a new see-through PNG, keeps the original, inherits tags and rights, and writes the usual previews", async () => {
    const id = await picture();
    const out = await run(id);
    expect(out.id).not.toBe(id);
    expect(out).toMatchObject({ kind: "image", mime: "image/png", source: "generated", caption: "A fox", originalName: "cutout-fox.png" });
    expect(out.tags).toEqual(expect.arrayContaining(["fox", "cutout"]));
    expect(out.rights.attestations).toHaveLength(1);
    expect(out.width).toBeLessThan(320); // trimmed to the object
    expect(Object.keys(out.derivedRefs)).toEqual(expect.arrayContaining(["preview", "thumb"]));
    expect((await getAsset(db.pool, id))!.deletedAt).toBeNull();
    const meta = await sharp(path.join(root, out.storageRef)).metadata();
    expect(meta.hasAlpha).toBe(true);
    expect((await db.ownerPool.query("select detail from audit_log where event = 'asset.cutout_made'")).rows).toHaveLength(1);
  });

  it("the sticker border and padding change the size, and the same settings on the same picture give the same file", async () => {
    const id = await picture();
    const plain = await run(id, { pad: 0, sticker: 0 });
    const sticker = await run(id, { pad: 0, sticker: 10 });
    expect(sticker.width!).toBeGreaterThan(plain.width!);
    const again = await run(id, { pad: 0, sticker: 0 });
    expect(again.id).toBe(plain.id); // identical bytes: the library keeps one
  });

  it("white-background method needs no model", async () => {
    const id = await picture();
    const out = await run(id, { method: "white", tolerance: 10 }, (async () => { throw new Error("the model must not run"); }) as Matte);
    expect(out.tags).toContain("cutout");
    expect((await sharp(path.join(root, out.storageRef)).metadata()).hasAlpha).toBe(true);
  });

  it("refuses, with a plain sentence and nothing saved, when nothing or too much is cut out, or a stranger asks", async () => {
    const photo = await picture("#336699"); // no white background
    const folders = () => readdirSync(path.join(root, "assets")).length;
    const before = folders();
    await expect(run(photo, { method: "white", tolerance: 5 })).rejects.toThrow(/nothing was cut out/);
    const noop: Matte = async (i, o) => { await sharp(i).ensureAlpha().png().toFile(o); }; // a "model" that removes nothing
    await expect(run(photo, {}, noop)).rejects.toThrow(/no background to remove/);
    const all: Matte = async (i, o) => { const m = await sharp(i).metadata(); await sharp({ create: { width: m.width!, height: m.height!, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(o); };
    await expect(run(photo, {}, all)).rejects.toThrow(/whole picture would be removed/);
    await expect(run("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(CutoutRefused);
    expect((await db.pool.query("select count(*)::int n from assets")).rows[0].n).toBe(1);
    expect(folders()).toBe(before); // no leftover folders from the refused attempts
  });

  it("only a live picture can be cut out, and a source file that cannot be read is refused", async () => {
    const id = await picture();
    await db.ownerPool.query("update assets set kind = 'audio' where id = $1", [id]);
    await expect(run(id)).rejects.toThrow(/Only a picture/);
    await db.ownerPool.query("update assets set kind = 'image', storage_ref = 'assets/nope/main.png' where id = $1", [id]);
    await expect(run(id)).rejects.toThrow(/could not be read/);
    await db.ownerPool.query("update assets set storage_ref = '../../etc/passwd' where id = $1", [id]);
    await expect(run(id)).rejects.toThrow(/could not be read/);
    await db.ownerPool.query("update assets set deleted_at = now() where id = $1", [id]);
    await expect(run(id)).rejects.toThrow(/does not exist/);
  });

  it("one cut-out at a time: a second request is told to try again", async () => {
    const id = await picture();
    let release!: () => void;
    const slow: Matte = async (i, o) => { await new Promise<void>((r) => (release = r)); await fakeMatte(i, o); };
    const first = run(id, {}, slow);
    await new Promise((r) => setTimeout(r, 300));
    await expect(run(id)).rejects.toThrow(/Another cut-out/);
    release();
    await first;
    await expect(run(id)).resolves.toBeTruthy(); // the lock is free again
  });
});

describe("the real background remover", () => {
  it("runs in its own process on a real picture and returns a see-through cut-out (about 3 to 10 seconds)", async () => {
    const id = await picture("#87b5d9");
    const out = await makeCutout(db.pool, { root, ingest }, id, { ...DEFAULT_CUTOUT, pad: 0 });
    const { data, info } = await sharp(path.join(root, out.storageRef)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 20) clear++;
    expect(info.width).toBeLessThan(320);
    expect(clear).toBeGreaterThan(0);
  }, 180_000);
});
