import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RIGHTS_TEXT } from "@/server/core/asset-rules";
import { registerAsset } from "@/server/db/assets";
import { cutoutJobsFor, MAX_QUEUED_CUTOUTS, queueCutout, STALE_AFTER_MINUTES, sweepStaleCutouts } from "@/server/db/cutout-jobs";
import { runNextCutout } from "@/server/db/cutout-runner";
import { runChild } from "@/server/render/child";
import type { Matte } from "@/server/render/cutout";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let root: string;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "cutout-jobs-")));
  db = await withTestDb();
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(() => db.reset());

const svg = `<svg width="200" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="160" fill="#fff"/><circle cx="100" cy="80" r="50" fill="#2a7"/></svg>`;
async function picture(): Promise<string> {
  const rel = `assets/s-${Math.random().toString(36).slice(2)}`;
  mkdirSync(path.join(root, rel), { recursive: true });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(path.join(root, rel, "main.png"), buf);
  return (await registerAsset(db.pool, { kind: "image", originalName: "dot.png", mime: "image/png", bytes: buf.length, width: 200, height: 160, sha256: [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join(""), storageRef: `${rel}/main.png`, tags: [], source: "upload", rights: { attestations: [{ at: new Date().toISOString(), text: RIGHTS_TEXT }] } } as never)).asset.id;
}
const matte: Matte = async (i, o) => {
  const { data, info } = await sharp(i).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let p = 0; p < data.length; p += 4) if (data[p]! > 240 && data[p + 1]! > 240) data[p + 3] = 0;
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(o);
};
const deps = () => ({ root, ingest: { runChild }, matte });

describe("queueCutout", () => {
  it("adds a queued row, audited, and checks the picture and the settings now", async () => {
    const id = await picture();
    const r = await queueCutout(db.pool, id, { method: "white", sticker: "6" });
    expect(r.ok).toBe(true);
    const [job] = await cutoutJobsFor(db.pool, id);
    expect(job).toMatchObject({ status: "queued", method: "white", assetId: id });
    expect((await db.pool.query("select options from cutout_jobs")).rows[0].options).toMatchObject({ method: "white", sticker: 6, erode: 1 });
    expect((await db.ownerPool.query("select 1 from audit_log where event = 'asset.cutout_queued'")).rowCount).toBe(1);
    expect(await queueCutout(db.pool, id, { erode: 9 })).toMatchObject({ ok: false });
    expect(await queueCutout(db.pool, "00000000-0000-4000-8000-000000000000", {})).toMatchObject({ ok: false, message: expect.stringMatching(/does not exist/) });
    expect(await queueCutout(db.pool, "not-an-id", {})).toMatchObject({ ok: false });
    await db.ownerPool.query("update assets set kind = 'audio' where id = $1", [id]);
    expect(await queueCutout(db.pool, id, {})).toMatchObject({ ok: false, message: expect.stringMatching(/Only a picture/) });
  });
  it(`stops asking after ${MAX_QUEUED_CUTOUTS} waiting jobs`, async () => {
    const id = await picture();
    for (let i = 0; i < MAX_QUEUED_CUTOUTS; i++) expect((await queueCutout(db.pool, id, {})).ok).toBe(true);
    expect(await queueCutout(db.pool, id, {})).toMatchObject({ ok: false, message: expect.stringMatching(/already waiting/) });
  });
});

describe("runNextCutout", () => {
  it("makes the oldest job first, writes the new picture on the row, and returns null when nothing is queued", async () => {
    const a = await picture();
    const b = await picture();
    await queueCutout(db.pool, a, { method: "model" });
    await queueCutout(db.pool, b, { method: "model" });
    const first = await runNextCutout(db.pool, deps());
    expect(first).toMatchObject({ assetId: a, status: "done" });
    expect(first!.resultAssetId).toBeTruthy();
    expect((await cutoutJobsFor(db.pool, b))[0]!.status).toBe("queued"); // not touched yet
    expect(await runNextCutout(db.pool, deps())).toMatchObject({ assetId: b, status: "done" });
    expect(await runNextCutout(db.pool, deps())).toBeNull();
  });
  it("puts a plain sentence on the row when the picture is refused, and never throws", async () => {
    const id = await picture();
    await queueCutout(db.pool, id, { method: "model" });
    const noop: Matte = async (i, o) => { await sharp(i).ensureAlpha().png().toFile(o); };
    const r = await runNextCutout(db.pool, { ...deps(), matte: noop });
    expect(r).toMatchObject({ status: "failed", resultAssetId: null, error: expect.stringMatching(/no background to remove/) });
  });
  it("an unexpected crash becomes a fixed sentence, never the raw error", async () => {
    const id = await picture();
    await queueCutout(db.pool, id, {});
    const boom: Matte = async () => { throw new Error("secret /Users/someone/path exploded"); };
    const r = await runNextCutout(db.pool, { ...deps(), matte: boom });
    expect(r).toMatchObject({ status: "failed", error: "The cut-out could not be made." });
  });
  it("re-checks the stored settings: a hand-edited row cannot run with out-of-range values", async () => {
    const id = await picture();
    await queueCutout(db.pool, id, {});
    await db.ownerPool.query(`update cutout_jobs set options = '{"method":"model","erode":99,"feather":1,"pad":8,"sticker":0,"tolerance":24}'`);
    expect(await runNextCutout(db.pool, deps())).toMatchObject({ status: "failed", error: expect.stringMatching(/Erode has to be/) });
  });
  it("two workers never take the same job", async () => {
    const id = await picture();
    await queueCutout(db.pool, id, {});
    const slow: Matte = async (i, o) => { await new Promise((r) => setTimeout(r, 400)); await matte(i, o); };
    const [x, y] = await Promise.all([runNextCutout(db.pool, { ...deps(), matte: slow }), runNextCutout(db.pool, { ...deps(), matte: slow })]);
    expect([x, y].filter((r) => r !== null)).toHaveLength(1);
  });
});

describe("sweepStaleCutouts", () => {
  it("fails a running job whose worker died, and leaves a fresh one alone", async () => {
    const id = await picture();
    await queueCutout(db.pool, id, {});
    await queueCutout(db.pool, id, {});
    await db.ownerPool.query(`update cutout_jobs set status = 'running', updated_at = now() - interval '${STALE_AFTER_MINUTES + 5} minutes' where id = (select id from cutout_jobs order by created_at limit 1)`);
    await db.ownerPool.query(`update cutout_jobs set status = 'running' where status = 'queued'`);
    expect(await sweepStaleCutouts(db.pool)).toBe(1);
    const rows = await cutoutJobsFor(db.pool, id);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "running"]);
    expect(rows.find((r) => r.status === "failed")!.error).toMatch(/worker stopped/);
  });
});
