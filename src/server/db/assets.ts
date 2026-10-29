import { z } from "zod";
import { checkRights, cleanOriginalName, refusalMessage, rightsSchema, type Rights, type RightsRefusal } from "@/server/core/asset-rules";
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
     returning *, (xmax = 0) as inserted`,
    [v.kind, cleanOriginalName(v.originalName), v.mime, v.bytes, v.width, v.height, v.durationS, v.sha256, v.storageRef, JSON.stringify(v.derivedRefs),
     v.tags, v.caption, v.source, JSON.stringify(v.rights), v.keep, v.createdBy],
  );
  const row = rows[0]!;
  return { asset: toAsset(row), duplicate: !row.inserted };
}

export async function getAsset(db: Db, id: string): Promise<Asset | null> {
  const { rows } = await db.query<Row>("select * from assets where id = $1", [id]);
  return rows[0] ? toAsset(rows[0]) : null;
}
