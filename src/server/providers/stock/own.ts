import { findAssetsByTag, getAsset } from "@/server/db/assets";
import type { StockDeps, StockProvider, StockSearch } from "./index";
import { licensed, StockError } from "./index";

// The owner's own library (assets table), matched by tag. Images only; nothing is downloaded, the stored file is used.
export function ownStock(deps: StockDeps): StockProvider {
  const own = () => { if (!deps.own) throw new StockError("The owner's library is not available here."); return deps.own; };
  return {
    async search(a: StockSearch) {
      if (a.kind !== "image") return [];
      const tags = a.query.toLowerCase().split(/\s+/).filter(Boolean);
      if (tags.length === 0) return [];
      const rows = await findAssetsByTag(own().db, tags, a.count * 3);
      return licensed(
        rows.filter((r) => r.width && r.height && (a.orientation === "portrait" ? r.height > r.width : r.width >= r.height)).map((r) => ({
          id: r.id, title: r.originalName, url: r.id, pageUrl: `/assets/${r.id}`, licence: "Own file", attribution: "Own file", width: r.width!, height: r.height!,
        })),
        a,
      );
    },
    async fetch(_ctx, hit) {
      const { db, resolvePath } = own();
      const asset = await getAsset(db, hit.id);
      if (!asset || asset.deletedAt) throw new StockError("That file is no longer in your library.");
      return {
        path: resolvePath(asset.storageRef), bytes: asset.bytes, sha256: asset.sha256,
        ...(asset.width ? { width: asset.width } : {}), ...(asset.height ? { height: asset.height } : {}),
        provenance: { provider: "own_stock", params: { id: asset.id }, priceMicroUsd: 0, quoted: true, licence: "Own file", sourceUrl: hit.pageUrl, attribution: "Own file" },
      };
    },
  };
}
