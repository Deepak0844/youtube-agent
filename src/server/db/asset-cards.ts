import type pg from "pg";
import type { Asset } from "./assets";
import { mediaSigner } from "./queue-data";

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
}

export async function toCards(db: pg.Pool, assets: Asset[]): Promise<AssetCard[]> {
  const sign = await mediaSigner(db);
  return assets.map((a) => ({
    id: a.id, kind: a.kind, name: a.originalName, tags: a.tags, keep: a.keep, url: sign ? sign(a.storageRef) : null, purgeAt: a.purgeAt?.toISOString() ?? null,
  }));
}
