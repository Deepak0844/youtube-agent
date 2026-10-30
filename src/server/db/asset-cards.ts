import type pg from "pg";
import type { Asset } from "./assets";
import { deletesOn } from "@/server/core/asset-deletion";
import { mediaSigner } from "./queue-data";
import { loadAssetDays } from "./asset-settings";

// What the assets page, the detail page and the picker show about an asset. Previews are signed media URLs only: the
// stored path (assets/<job>/<file>) is never put in a page. No signing key (vault locked) means no preview, not a raw path.
export interface AssetCard {
  id: string;
  kind: Asset["kind"];
  name: string;
  tags: string[];
  keep: boolean;
  /** Signed URL of the stored file, for an <img> (images) or <audio> (sound). */
  url: string | null;
  purgeAt: string | null;
  /** When an upload will be cleaned up automatically (null: never, or not an upload). */
  deletesOn: string | null;
}

export async function toCards(db: pg.Pool, assets: Asset[]): Promise<AssetCard[]> {
  const [sign, { unusedDays, retentionDays }] = await Promise.all([mediaSigner(db), loadAssetDays(db)]);
  return assets.map((a) => ({
    id: a.id, kind: a.kind, name: a.originalName, tags: a.tags, keep: a.keep, url: sign ? sign(a.storageRef) : null, purgeAt: a.purgeAt?.toISOString() ?? null,
    // No table links an asset to a video yet, so nothing counts as used, finished or pinned until those phases land.
    deletesOn: a.source === "upload" && !a.deletedAt
      ? (deletesOn({ finishedAt: null, keep: a.keep, pinnedToSeries: false, retentionDays, createdAt: a.createdAt, usedByAnyVideo: false, unusedDays })?.toISOString() ?? null)
      : null,
  }));
}
