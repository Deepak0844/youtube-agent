import { lstat } from "node:fs/promises";
import path from "node:path";
import { safeJoin } from "@/server/storage/paths";
import type { Db } from "./stages";

// SECURITY CONTROL: what an engine run may list and copy (list_assets / fetch_asset). Sound effects and music come from
// audio_items (licence text required); pictures and clips from assets (live rows with at least one rights attestation).
// Every query is parameterised and the search text is escaped for LIKE; files resolve through safeJoin inside storage only.

export type EngineAssetKind = "sfx" | "music" | "image" | "video";
export interface EngineAsset {
  id: string;
  kind: EngineAssetKind;
  name: string;
  licence: string;
  durationS?: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT = 50;
const LIKE = `'%' || replace(replace(replace($2, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'`;

export async function engineListAssets(db: Db, kind: EngineAssetKind, query?: string): Promise<EngineAsset[]> {
  const q = typeof query === "string" && query.trim() ? query.trim().slice(0, 80) : null;
  if (kind === "sfx" || kind === "music") {
    const { rows } = await db.query<{ id: string; name: string; licence: string; duration_s: string | null }>(
      `select id, name, licence, duration_s from audio_items
        where kind = $1 and btrim(licence) <> ''
          and ($2::text is null or name ilike ${LIKE} or lower($2) = any(tags))
        order by name, id limit ${LIMIT}`,
      [kind, q],
    );
    return rows.map((r) => ({ id: `audio:${r.id}`, kind, name: r.name, licence: r.licence, ...(r.duration_s !== null ? { durationS: Number(r.duration_s) } : {}) }));
  }
  const { rows } = await db.query<{ id: string; original_name: string; licence: string; duration_s: string | null }>(
    `select id, original_name, rights -> 'attestations' -> 0 ->> 'text' as licence, duration_s from assets
      where kind = $1 and deleted_at is null and jsonb_array_length(coalesce(rights -> 'attestations', '[]'::jsonb)) > 0
        and ($2::text is null or original_name ilike ${LIKE} or lower($2) = any(tags))
      order by original_name, id limit ${LIMIT}`,
    [kind, q],
  );
  return rows.map((r) => ({ id: `asset:${r.id}`, kind, name: r.original_name, licence: r.licence, ...(r.duration_s !== null ? { durationS: Number(r.duration_s) } : {}) }));
}

/** The stored file of a listed id ("audio:<uuid>" or "asset:<uuid>"), inside storage and a plain file; else null. */
export async function engineAssetFile(db: Db, storageRoot: string, id: string): Promise<string | null> {
  const m = /^(audio|asset):(.+)$/.exec(typeof id === "string" ? id : "");
  if (!m || !UUID.test(m[2]!)) return null;
  const row =
    m[1] === "audio"
      ? (await db.query<{ rel: string }>("select file_path as rel from audio_items where id = $1 and btrim(licence) <> ''", [m[2]])).rows[0]
      : (await db.query<{ rel: string }>("select storage_ref as rel from assets where id = $1 and deleted_at is null and jsonb_array_length(coalesce(rights -> 'attestations', '[]'::jsonb)) > 0", [m[2]])).rows[0];
  if (!row) return null;
  let file: string;
  try {
    file = m[1] === "audio" ? await safeJoin(path.join(storageRoot, "audio"), ...row.rel.split("/")) : await safeJoin(storageRoot, ...row.rel.split("/"));
  } catch {
    return null;
  }
  const st = await lstat(file).catch(() => null);
  return st?.isFile() ? file : null;
}
