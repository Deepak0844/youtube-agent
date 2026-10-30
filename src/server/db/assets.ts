import { z } from "zod";
import { checkRights, cleanOriginalName, refusalMessage, rightsSchema, type Rights, type RightsRefusal } from "@/server/core/asset-rules";
import { loadAssetDays } from "./asset-settings";
import type { Db } from "./stages";

// SQL for the assets table (migration 0028). Dedupe is one INSERT ... ON CONFLICT (sha256) DO UPDATE statement, so two
// racing uploads of the same bytes make one row and the loser's attestation, tags and Keep flag are merged in atomically.

export interface Asset {
  id: string;
  kind: "image" | "audio";
  originalName: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  sha256: string;
  storageRef: string;
  derivedRefs: Record<string, string>;
  tags: string[];
  caption: string | null;
  source: "upload" | "generated" | "stock" | "found";
  rights: Rights;
  keep: boolean;
  createdBy: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  purgeAt: Date | null;
}

export class AssetRefused extends Error {
  constructor(readonly reason: RightsRefusal | "invalid") {
    super(reason === "invalid" ? "The asset details are not valid." : refusalMessage(reason));
  }
}

const SHA = /^[0-9a-f]{64}$/;
const input = z.object({
  kind: z.enum(["image", "audio"]),
  originalName: z.string(),
  mime: z.string().min(1),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationS: z.number().nonnegative().nullable().default(null),
  sha256: z.string().regex(SHA),
  storageRef: z.string().min(1),
  derivedRefs: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string().min(1).max(60)).max(50).default([]),
  caption: z.string().max(500).nullable().default(null),
  source: z.enum(["upload", "generated", "stock", "found"]).default("upload"),
  rights: rightsSchema,
  keep: z.boolean().default(false),
  createdBy: z.string().nullable().default(null),
  containsPerson: z.boolean().default(false),
  voiceCloneReference: z.boolean().default(false),
});
export type RegisterInput = z.input<typeof input>;

interface Row {
  id: string; kind: Asset["kind"]; original_name: string; mime: string; bytes: string | number; width: number | null; height: number | null;
  duration_s: string | null; sha256: string; storage_ref: string; derived_refs: Record<string, string>; tags: string[]; caption: string | null;
  source: Asset["source"]; rights: Rights; keep: boolean; created_by: string | null; created_at: Date; deleted_at: Date | null; purge_at: Date | null;
  inserted?: boolean;
}

const toAsset = (r: Row): Asset => ({
  id: r.id, kind: r.kind, originalName: r.original_name, mime: r.mime, bytes: Number(r.bytes), width: r.width, height: r.height,
  durationS: r.duration_s === null ? null : Number(r.duration_s), sha256: r.sha256, storageRef: r.storage_ref, derivedRefs: r.derived_refs,
  tags: r.tags, caption: r.caption, source: r.source, rights: r.rights, keep: r.keep, createdBy: r.created_by, createdAt: r.created_at,
  deletedAt: r.deleted_at, purgeAt: r.purge_at,
});

/**
 * Stores a new asset or merges into the existing one with the same original bytes (sha256). On a duplicate: Keep is
 * OR-ed, tags are unioned, every rights attestation is appended, and a pending deletion is cancelled. The existing
 * row's files and name stay; the caller discards the duplicate's freshly written files when `duplicate` is true.
 * Throws AssetRefused (nothing written) when rights are missing or a needed consent is absent.
 */
export async function registerAsset(db: Db, a: RegisterInput): Promise<{ asset: Asset; duplicate: boolean }> {
  const p = input.safeParse(a);
  if (!p.success) throw new AssetRefused("invalid");
  const v = p.data;
  const verdict = checkRights(v.rights, { kind: v.kind, tags: v.tags, containsPerson: v.containsPerson, voiceCloneReference: v.voiceCloneReference });
  if (!verdict.ok) throw new AssetRefused(verdict.reason);
  const { rows } = await db.query<Row>(
    `insert into assets (kind, original_name, mime, bytes, width, height, duration_s, sha256, storage_ref, derived_refs, tags, caption, source, rights, keep, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::text[],$12,$13,$14::jsonb,$15,$16)
     on conflict (sha256) do update set
       keep = assets.keep or excluded.keep,
       tags = (select coalesce(array_agg(distinct t), '{}') from unnest(assets.tags || excluded.tags) as t),
       rights = jsonb_build_object('attestations', (assets.rights -> 'attestations') || (excluded.rights -> 'attestations')),
       deleted_at = null,
       purge_at = null
     where assets.purge_at is null or assets.purge_at > now()
     returning *, (xmax = 0) as inserted`,
    [v.kind, cleanOriginalName(v.originalName), v.mime, v.bytes, v.width, v.height, v.durationS, v.sha256, v.storageRef, JSON.stringify(v.derivedRefs),
     v.tags, v.caption, v.source, JSON.stringify(v.rights), v.keep, v.createdBy],
  );
  // No row back: the existing one is past its purge date, so it is being deleted and must not be revived (purgeDueAsset).
  const row = rows[0];
  if (!row) throw new Error("This file is being cleaned up. Try the upload again in a moment.");
  return { asset: toAsset(row), duplicate: !row.inserted };
}

export async function getAsset(db: Db, id: string): Promise<Asset | null> {
  const { rows } = await db.query<Row>("select * from assets where id = $1", [id]);
  return rows[0] ? toAsset(rows[0]) : null;
}

/** Live image assets carrying any of these tags, newest first. */
export async function findAssetsByTag(db: Db, tags: string[], limit: number): Promise<Asset[]> {
  const { rows } = await db.query<Row>("select * from assets where kind = 'image' and deleted_at is null and tags && $1::text[] order by created_at desc limit $2", [tags, limit]);
  return rows.map(toAsset);
}

export interface AssetFilter {
  kind?: Asset["kind"];
  tag?: string;
  source?: Asset["source"];
  q?: string;
  trash?: boolean;
}

/** Newest first. `trash` lists deleted ones still inside their 7 days; otherwise only live ones. The name search escapes LIKE wildcards. */
export async function listAssets(db: Db, f: AssetFilter, limit = 200): Promise<Asset[]> {
  const { rows } = await db.query<Row>(
    `select * from assets
      where ${f.trash ? "deleted_at is not null and purge_at > now()" : "deleted_at is null"}
        and ($1::text is null or kind = $1) and ($2::text is null or $2 = any(tags)) and ($3::text is null or source = $3)
        and ($4::text is null or original_name ilike '%' || replace(replace(replace($4, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
      order by created_at desc, id limit $5`,
    [f.kind ?? null, f.tag ?? null, f.source ?? null, f.q ?? null, limit],
  );
  return rows.map(toAsset);
}

export async function listTags(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ t: string }>("select distinct unnest(tags) as t from assets where deleted_at is null order by t");
  return rows.map((r) => r.t);
}

export async function setKeep(db: Db, id: string, keep: boolean): Promise<boolean> {
  const r = await db.query("update assets set keep = $2 where id = $1 and deleted_at is null", [id, keep]);
  return (r.rowCount ?? 0) > 0;
}

export async function tagAssets(db: Db, ids: string[], tags: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update assets set tags = (select coalesce(array_agg(distinct t), '{}') from unnest(tags || $2::text[]) as t)
      where id = any($1::uuid[]) and deleted_at is null returning id`,
    [ids, tags],
  );
  return rows.map((r) => r.id);
}

/** Moves to the trash for `assets.trash_days` (7 by default). A Keep asset is left alone unless `confirmKeep`; the ones held back are returned so the page can ask. */
export async function trashAssets(db: Db, ids: string[], confirmKeep: boolean): Promise<{ trashed: string[]; keptBlocked: string[] }> {
  const { trashDays } = await loadAssetDays(db);
  const { rows } = await db.query<{ id: string; keep: boolean }>(
    `update assets set deleted_at = now(), purge_at = now() + make_interval(days => $3)
      where id = any($1::uuid[]) and deleted_at is null and ($2 or not keep) returning id, keep`,
    [ids, confirmKeep, trashDays],
  );
  const done = new Set(rows.map((r) => r.id));
  const held = await db.query<{ id: string }>("select id from assets where id = any($1::uuid[]) and keep and deleted_at is null", [ids.filter((i) => !done.has(i))]);
  return { trashed: [...done], keptBlocked: held.rows.map((r) => r.id) };
}

/** Works only while the safety window is open. */
export async function restoreAsset(db: Db, id: string): Promise<boolean> {
  const r = await db.query("update assets set deleted_at = null, purge_at = null where id = $1 and deleted_at is not null and purge_at > now()", [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * For the cleanup job (Phase 5). One statement locks the row and re-checks that it is still in the trash and past its
 * purge date, so a duplicate upload that revived it first wins and nothing is deleted. Returns the files to remove, or null.
 */
export async function purgeDueAsset(db: Db, id: string): Promise<{ storageRef: string; derivedRefs: Record<string, string> } | null> {
  const { rows } = await db.query<{ storage_ref: string; derived_refs: Record<string, string> }>(
    "delete from assets where id = $1 and deleted_at is not null and purge_at <= now() returning storage_ref, derived_refs",
    [id],
  );
  return rows[0] ? { storageRef: rows[0].storage_ref, derivedRefs: rows[0].derived_refs } : null;
}
