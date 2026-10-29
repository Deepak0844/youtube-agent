import type { Db } from "./stages";

// SQL for audio_items (migration 0027). Library first: Task 12 asks here before generating any sound.

export type AudioKind = "sfx" | "music";
export interface AudioItem {
  id: string;
  kind: AudioKind;
  name: string;
  tags: string[];
  source: "shipped" | "owned" | "generated" | "upload";
  licence: string;
  provenance: Record<string, unknown>;
  filePath: string;
  sha256: string;
  durationS: number | null;
  meanLufs: number | null;
  peakDbfs: number | null;
  usedIn: string[];
  createdAt: Date;
}
export type NewAudioItem = Omit<AudioItem, "id" | "usedIn" | "createdAt">;

export class AudioRefused extends Error {
  constructor() {
    super("This sound has no licence text, so it cannot be added to the library.");
  }
}

const COLS = `id, kind, name, tags, source, licence, provenance, file_path as "filePath", sha256,
  duration_s::float8 as "durationS", mean_lufs::float8 as "meanLufs", peak_dbfs::float8 as "peakDbfs", used_in as "usedIn", created_at as "createdAt"`;

/** Adds the item; if the same bytes (sha256) are already there, returns the existing row unchanged. */
export async function addAudioItem(db: Db, i: NewAudioItem): Promise<AudioItem> {
  if (!i.licence.trim()) throw new AudioRefused();
  const ins = await db.query<AudioItem>(
    `insert into audio_items (kind, name, tags, source, licence, provenance, file_path, sha256, duration_s, mean_lufs, peak_dbfs)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (sha256) do nothing returning ${COLS}`,
    [i.kind, i.name, i.tags, i.source, i.licence, i.provenance, i.filePath, i.sha256, i.durationS, i.meanLufs, i.peakDbfs],
  );
  if (ins.rows[0]) return ins.rows[0];
  return (await db.query<AudioItem>(`select ${COLS} from audio_items where sha256 = $1`, [i.sha256])).rows[0]!;
}

/** Items sharing at least one tag, most shared tags first, then the least used. */
export async function findLibraryFirst(db: Db, q: { kind: AudioKind; tags: string[]; maxDurationS?: number }): Promise<AudioItem[]> {
  const { rows } = await db.query<AudioItem>(
    `select ${COLS} from (
       select *, cardinality(array(select unnest(tags) intersect select unnest($2::text[]))) as overlap
       from audio_items where kind = $1 and ($3::numeric is null or duration_s <= $3)
     ) t where overlap > 0
     order by overlap desc, jsonb_array_length(used_in), created_at, id`,
    [q.kind, q.tags, q.maxDurationS ?? null],
  );
  return rows;
}

/** Records that a video used the item. Once per video. */
export async function markUsed(db: Db, itemId: string, videoId: string): Promise<void> {
  await db.query("update audio_items set used_in = used_in || to_jsonb($2::text) where id = $1 and not used_in ? $2::text", [itemId, videoId]);
}

/** Library file path (relative to the library root) for each id; ids not in the library are missing from the map. */
export async function audioFilePaths(db: Db, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await db.query<{ id: string; file_path: string }>("select id, file_path from audio_items where id::text = any($1::text[])", [ids]);
  return new Map(rows.map((r) => [r.id, r.file_path]));
}
