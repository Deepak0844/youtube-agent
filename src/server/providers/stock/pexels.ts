import { allowedUrl, defaultFetcher, downloadStock, failMessage, licensed, pickFile, PORTRAIT_MAX_WIDTH, requireKey, type StockDeps, type StockHit, type StockProvider, type StockSearch } from "./index";

// Pexels API (https://www.pexels.com/api/documentation/): key in the Authorization header; photos[].src, videos[].video_files[].
const HOSTS = { api: "api.pexels.com", cdn: ["images.pexels.com", "videos.pexels.com"] } as const;
const LICENCE = "Pexels License";

interface Photo { id: number; width: number; height: number; url: string; photographer?: string; alt?: string; src?: { original?: string } }
interface Video { id: number; width: number; height: number; url: string; duration?: number; user?: { name?: string }; video_files?: { file_type?: string; width: number; height: number; link: string }[] }

export function pexelsStock(deps: StockDeps): StockProvider {
  const get = async (pathAndQuery: string): Promise<unknown> => {
    const key = await requireKey(deps, "Pexels");
    const res = await (deps.fetcher ?? defaultFetcher)(`https://${HOSTS.api}${pathAndQuery}`, { headers: { authorization: key }, redirect: "manual" });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); throw failMessage("Pexels", res.status); }
    return res.json();
  };
  const credit = (who?: string) => (who ? `${who} on Pexels` : "Pexels");
  return {
    async search(a: StockSearch) {
      const q = new URLSearchParams({ query: a.query, per_page: String(Math.min(80, Math.max(1, a.count * 2))), orientation: a.orientation });
      const data = (await get(`${a.kind === "video" ? "/videos/search" : "/v1/search"}?${q}`)) as { photos?: Photo[]; videos?: Video[] };
      const hits: StockHit[] = [];
      for (const p of data.photos ?? []) {
        if (a.kind !== "image" || !p.src?.original || !(p.width > 0 && p.height > 0)) continue;
        // images.pexels.com resizes on request: ask for at most 1080 wide in portrait (1920 in landscape), never enlarging.
        const w = Math.min(p.width, a.orientation === "portrait" ? PORTRAIT_MAX_WIDTH : 1920);
        const url = new URL(p.src.original);
        url.search = `auto=compress&cs=tinysrgb&w=${w}`;
        hits.push({ id: String(p.id), title: p.alt || `Pexels photo ${p.id}`, url: url.href, pageUrl: p.url, ...(p.photographer ? { author: p.photographer } : {}), licence: LICENCE, attribution: `Photo by ${credit(p.photographer)}`, width: w, height: Math.round((p.height * w) / p.width) });
      }
      for (const v of data.videos ?? []) {
        if (a.kind !== "video") continue;
        const f = pickFile((v.video_files ?? []).filter((x) => x.file_type === "video/mp4"), a.orientation);
        if (!f) continue;
        hits.push({ id: String(v.id), title: `Pexels video ${v.id}`, url: f.link, pageUrl: v.url, ...(v.user?.name ? { author: v.user.name } : {}), licence: LICENCE, attribution: `Video by ${credit(v.user?.name)}`, width: f.width, height: f.height, ...(v.duration !== undefined ? { seconds: v.duration } : {}) });
      }
      return licensed(hits.filter((h) => { try { allowedUrl(h.url, HOSTS.cdn); return true; } catch { return false; } }), a);
    },
    fetch: (ctx, hit) => downloadStock(deps, ctx, "Pexels", "pexels", hit, HOSTS.cdn),
  };
}
