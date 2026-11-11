import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { CutoutOptions } from "@/server/core/cutout";
import { registerAsset, getAsset, type Asset } from "@/server/db/assets";
import { recordAudit } from "@/server/db/audit";
import { cutoutPng, CutoutRefused, modelMatte, type Matte } from "@/server/render/cutout";
import { ingestImage, type IngestDeps } from "@/server/render/ingest";
import { safeJoin } from "@/server/storage/paths";

export { CutoutRefused };

export interface CutoutDeps {
  root: string;
  ingest: IngestDeps;
  /** Test seams. */
  matte?: Matte;
  ingestFn?: typeof ingestImage;
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
// One cut-out at a time: the model is heavy. A second request is told to wait rather than queued.
const LOCK = "ytstudio.cutout";

/**
 * Makes a see-through cut-out of a library picture and saves it as a NEW library picture (the original is kept). The result goes through the same
 * sandboxed picture check as an upload, inherits the original's rights record, and is tagged `cutout`. A picture whose cut-out is identical to one
 * already in the library returns that one.
 */
export async function makeCutout(db: pg.Pool, deps: CutoutDeps, assetId: string, o: CutoutOptions, signal?: AbortSignal): Promise<Asset> {
  const src = await getAsset(db, assetId);
  if (!src || src.deletedAt) throw new CutoutRefused("That picture does not exist.");
  if (src.kind !== "image") throw new CutoutRefused("Only a picture can be cut out.");
  let file: string;
  try {
    file = await safeJoin(deps.root, src.storageRef);
    if ((await stat(file)).size > MAX_SOURCE_BYTES) throw new Error("big");
  } catch {
    throw new CutoutRefused("This picture's file could not be read.");
  }

  const lock = await db.connect();
  const incoming = path.join(deps.root, "assets-incoming", `cutout-${randomUUID()}.png`);
  const rel = `assets/${randomUUID()}`;
  const dest = path.join(deps.root, rel);
  let stored = false;
  try {
    const got = await lock.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtextextended($1, 0)) as ok", [LOCK]);
    if (!got.rows[0]?.ok) throw new CutoutRefused("Another cut-out is being made. Try again in a minute.");
    const png = await cutoutPng(await readFile(file), o, deps.matte ?? modelMatte, signal);
    await mkdir(path.dirname(incoming), { recursive: true });
    await mkdir(dest, { recursive: true });
    await writeFile(incoming, png, { flag: "wx" });
    const r = await (deps.ingestFn ?? ingestImage)(deps.ingest, { srcPath: incoming, destDir: dest, signal });
    if (!r.ok) throw new CutoutRefused("The finished cut-out did not pass the picture check, so it was not saved.");
    if (r.mime !== "image/png") throw new CutoutRefused("The finished cut-out has no see-through part, so it was not saved.");
    const refs = Object.fromEntries(Object.entries(r.files).map(([role, f]) => [role, `${rel}/${path.basename(f)}`]));
    const { main, ...derivedRefs } = refs;
    const base = src.originalName.replace(/\.[A-Za-z0-9]{1,5}$/, "");
    const reg = await registerAsset(db, {
      kind: "image", originalName: `cutout-${base}.png`, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, durationS: null, sha256: r.sha256, storageRef: main!, derivedRefs,
      tags: [...new Set([...src.tags.slice(0, 40), "cutout"])], caption: src.caption, source: "generated", rights: src.rights, keep: false, createdBy: null,
    });
    stored = !reg.duplicate;
    await recordAudit(db, "asset.cutout_made", { from: src.id, to: reg.asset.id, method: o.method, duplicate: reg.duplicate });
    return reg.asset;
  } finally {
    await lock.query("select pg_advisory_unlock(hashtextextended($1, 0))", [LOCK]).catch(() => undefined);
    lock.release();
    if (!stored) await rm(dest, { recursive: true, force: true }).catch(() => undefined);
    await rm(incoming, { force: true }).catch(() => undefined);
  }
}
