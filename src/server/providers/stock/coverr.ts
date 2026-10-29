import { allowedUrl, defaultFetcher, downloadStock, failMessage, licensed, requireKey, PORTRAIT_MAX_WIDTH, type StockDeps, type StockHit, type StockProvider, type StockSearch } from "./index";

// UNVERIFIED: the Coverr API shape below (GET /videos, Bearer key, hits[].urls.mp4, is_vertical, max_width, license) was
// not checked against the live docs. Coverr stays disabled and unpriced in the registry until Task 20 records it.
const HOSTS = { api: "api.coverr.co", cdn: ["cdn.coverr.co"] } as const;

interface Item { id: string; title?: string; is_vertical?: boolean; max_width?: number; max_height?: number; duration?: number; license?: string; urls?: { mp4?: string } }

export function coverrStock(deps: StockDeps): StockProvider {
  return {
    async search(a: StockSearch) {
      if (a.kind !== "video") return []; // Coverr is video only
      const key = await requireKey(deps, "Coverr");
      const q = new URLSearchParams({ query: a.query, page_size: String(Math.max(1, a.count * 2)), urls: "true" });
      const res = await (deps.fetcher ?? defaultFetcher)(`https://${HOSTS.api}/videos?${q}`, { headers: { authorization: `Bearer ${key}` }, redirect: "manual" });
      if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw failMessage("Coverr", res.status); }
      const hits: StockHit[] = [];
      for (const v of ((await res.json()) as { hits?: Item[] }).hits ?? []) {
        const w = v.max_width ?? 0, h = v.max_height ?? 0, url = v.urls?.mp4;
        if (!url || !(w > 0 && h > 0) || (a.orientation === "portrait" ? !(v.is_vertical && w <= PORTRAIT_MAX_WIDTH) : h > w)) continue;
        hits.push({ id: v.id, title: v.title || `Coverr video ${v.id}`, url, pageUrl: `https://coverr.co/videos/${encodeURIComponent(v.id)}`, licence: v.license ?? "", attribution: "Video from Coverr", width: w, height: h, ...(v.duration !== undefined ? { seconds: v.duration } : {}) });
      }
      return licensed(hits.filter((h) => { try { allowedUrl(h.url, HOSTS.cdn); return true; } catch { return false; } }), a);
    },
    fetch: (ctx, hit) => downloadStock(deps, ctx, "Coverr", "coverr", hit, HOSTS.cdn),
  };
}
