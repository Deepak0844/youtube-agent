import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type pg from "pg";
import { safeJoin } from "@/server/storage/paths";

type Db = pg.Pool | pg.PoolClient;

export interface VoiceLineRow {
  cacheKey: string;
  provider: string;
  bytes: number;
  sha256: string;
  durationS: number;
  wordTimings: Array<{ word: string; startS: number; endS: number }> | null;
  timingsKind: "native" | "aligned" | "estimated" | "none";
  filePath: string;
  priceMicroUsd: number;
}

const COLS = `cache_key as "cacheKey", provider, bytes::float8 as bytes, sha256, duration_s::float8 as "durationS", word_timings as "wordTimings",
  timings_kind as "timingsKind", file_path as "filePath", price_micro_usd::float8 as "priceMicroUsd"`;
const KEY = /^[0-9a-f]{64}$/;

export async function lookupLine(db: Db, cacheKey: string): Promise<VoiceLineRow | null> {
  const { rows } = await db.query<VoiceLineRow>(`select ${COLS} from voice_lines where cache_key = $1`, [cacheKey]);
  return rows[0] ?? null;
}

export async function touchLine(db: Db, cacheKey: string): Promise<void> {
  await db.query("update voice_lines set last_used_at = now() where cache_key = $1", [cacheKey]);
}

/** Moves a finished audio file to `<root>/voice-cache/<first two hex>/<key>.<ext>` (copy then rename, so no half file is ever at the final path). Returns the path relative to root. */
export async function placeLineFile(root: string, cacheKey: string, ext: string, from: string): Promise<string> {
  if (!KEY.test(cacheKey) || !/^[a-z0-9]{1,5}$/.test(ext)) throw new Error("invalid cache key or extension");
  const rel = `voice-cache/${cacheKey.slice(0, 2)}/${cacheKey}.${ext}`;
  const dest = await safeJoin(root, ...rel.split("/"));
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await copyFile(from, tmp);
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
  return rel;
}

/** Inserts the row (first writer wins) only after its file is on disk with the stated size. Returns false if the key was already stored. */
export async function storeLine(db: Db, root: string, row: VoiceLineRow): Promise<boolean> {
  if (!KEY.test(row.cacheKey)) throw new Error("invalid cache key");
  const st = await stat(await safeJoin(root, ...row.filePath.split("/"))).catch(() => null);
  if (!st?.isFile() || st.size !== row.bytes) throw new Error("the voice file is not on disk yet");
  const r = await db.query(
    `insert into voice_lines (cache_key, provider, bytes, sha256, duration_s, word_timings, timings_kind, file_path, price_micro_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (cache_key) do nothing`,
    [row.cacheKey, row.provider, row.bytes, row.sha256, row.durationS, row.wordTimings === null ? null : JSON.stringify(row.wordTimings), row.timingsKind, row.filePath, row.priceMicroUsd],
  );
  return r.rowCount === 1;
}
