import { allowedUrl, defaultFetcher, downloadStock, failMessage, licensed, pickFile, requireKey, type StockDeps, type StockHit, type StockProvider, type StockSearch } from "./index";

// Pixabay API (https://pixabay.com/api/docs/): the key is a query parameter. Hits: webformatURL with webformatWidth/Height
// (640 on the longest edge), videos{large,medium,small,tiny}.url, user, pageURL, tags. URLs are used exactly as returned: they
// are signed, and a changed suffix (_640 -> _960) answers 400 "invalid or expired" (live check, 2026-10-30). largeImageURL is
// 1280 wide but no width for it is reported (imageWidth is the original), so it is not used.
// Licence: the answer carries no licence text; every Pixabay file is under the Pixabay Content License, so the adapter stamps it.
const HOSTS = { api: "pixabay.com", cdn: ["pixabay.com", "cdn.pixabay.com"] } as const;
const LICENCE = "Pixabay Content License";

interface Image { id: number; pageURL: string; tags?: string; user?: string; webformatURL: string; webformatWidth: number; webformatHeight: number }
interface Video { id: number; pageURL: string; tags?: string; user?: string; duration?: number; videos?: Record<string, { url: string; width: number; height: number }> }

export function pixabayStock(deps: StockDeps): StockProvider {
  const get = async (path: string, params: Record<string, string>): Promise<{ hits?: unknown[] }> => {
    const key = await requireKey(deps, "Pixabay");
    const u = new URL(`https://${HOSTS.api}${path}`);
    for (const [k, v] of Object.entries({ ...params, key })) u.searchParams.set(k, v); // the key goes only here, never logged
    const res = await (deps.fetcher ?? defaultFetcher)(u.href, { redirect: "manual" });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw failMessage("Pixabay", res.status); }
    return res.json();
  };
  return {
    async search(a: StockSearch) {
      const per_page = String(Math.min(200, Math.max(3, a.count * 2)));
      const hits: StockHit[] = [];
      if (a.kind === "image") {
        const d = await get("/api/", { q: a.query, image_type: "photo", orientation: a.orientation === "portrait" ? "vertical" : "horizontal", per_page, safesearch: "true" });
        for (const i of (d.hits ?? []) as Image[]) {
          hits.push({ id: String(i.id), title: i.tags || `Pixabay image ${i.id}`, url: i.webformatURL, pageUrl: i.pageURL, ...(i.user ? { author: i.user } : {}), licence: LICENCE, attribution: `Image by ${i.user ?? "Pixabay"} on Pixabay`, width: i.webformatWidth, height: i.webformatHeight });
        }
      } else {
        const d = await get("/api/videos/", { q: a.query, per_page });
        for (const v of (d.hits ?? []) as Video[]) {
          const f = pickFile(Object.values(v.videos ?? {}).filter((x) => x.url), a.orientation);
          if (!f) continue;
          hits.push({ id: String(v.id), title: v.tags || `Pixabay video ${v.id}`, url: f.url, pageUrl: v.pageURL, ...(v.user ? { author: v.user } : {}), licence: LICENCE, attribution: `Video by ${v.user ?? "Pixabay"} on Pixabay`, width: f.width, height: f.height, ...(v.duration !== undefined ? { seconds: v.duration } : {}) });
        }
      }
      return licensed(hits.filter((h) => { try { allowedUrl(h.url, HOSTS.cdn); return true; } catch { return false; } }), a);
    },
    fetch: (ctx, hit) => downloadStock(deps, ctx, "Pixabay", "pixabay", hit, HOSTS.cdn),
  };
}
