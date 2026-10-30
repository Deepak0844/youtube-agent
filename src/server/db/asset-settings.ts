import type pg from "pg";
import { getSetting } from "@/server/db/settings";

// Readers for /settings/assets and the Assets page. The writer is saveAssetSettings in system-settings.ts (the guarded
// session-writer module). Sizes show in MB / GB / megapixels; they are stored as bytes and pixels.
const MB = 1024 ** 2;
const GB = 1024 ** 3;

export interface AssetSettingsView {
  retentionDays: number;
  unusedDays: number;
  trashDays: number;
  maxImageMb: number;
  maxAudioMb: number;
  maxMegapixels: number;
  maxBatchFiles: number;
  totalGb: number;
}

const get = (db: pg.Pool, k: string) => getSetting(db, k) as Promise<number>;

export async function loadAssetSettings(db: pg.Pool): Promise<AssetSettingsView> {
  const [retentionDays, unusedDays, trashDays, img, aud, px, maxBatchFiles, total] = await Promise.all([
    get(db, "assets.retention_days"), get(db, "assets.unused_days"), get(db, "assets.trash_days"), get(db, "assets.max_image_bytes"),
    get(db, "assets.max_audio_bytes"), get(db, "assets.max_pixels"), get(db, "assets.max_batch_files"), get(db, "assets.total_bytes_cap"),
  ]);
  return { retentionDays, unusedDays, trashDays, maxImageMb: img / MB, maxAudioMb: aud / MB, maxMegapixels: px / 1_000_000, maxBatchFiles, totalGb: total / GB };
}

/** Just the three day counts, for the Assets page and the trash. */
export async function loadAssetDays(db: pg.Pool | pg.PoolClient): Promise<{ retentionDays: number; unusedDays: number; trashDays: number }> {
  const [retentionDays, unusedDays, trashDays] = (await Promise.all(["assets.retention_days", "assets.unused_days", "assets.trash_days"].map((k) => getSetting(db, k)))) as number[];
  return { retentionDays: retentionDays!, unusedDays: unusedDays!, trashDays: trashDays! };
}
