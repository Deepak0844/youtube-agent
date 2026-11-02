import type { PictureCandidate } from "@/server/core/picture-rank";
import { stripHtml } from "./wikimedia";

// Pixabay image search for the pictures stage (the key is a query parameter and goes only into the URL built here).
// largeImageURL is 1280 px on the long side; imageWidth/imageHeight are the original's size, used for the quality check.
// Every file is under the Pixabay Content License (no licence text in the answer, so it is stamped here).
const LICENCE = "Pixabay Content License";

export function pixabaySearchUrl(query: string, key: string, perPage: number): string {
  const p = new URLSearchParams({ key, q: query, image_type: "photo", safesearch: "true", per_page: String(perPage) });
  return `https://pixabay.com/api/?${p.toString()}`;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const mimeOf = (url: string): string => (/\.png(\?|$)/i.test(url) ? "image/png" : /\.webp(\?|$)/i.test(url) ? "image/webp" : "image/jpeg");

export function parsePixabay(json: unknown): PictureCandidate[] {
  const hits = obj(json).hits;
  if (!Array.isArray(hits)) return [];
  const out: PictureCandidate[] = [];
  for (const raw of hits) {
    const h = obj(raw);
    const url = typeof h.largeImageURL === "string" ? h.largeImageURL : "";
    const pageUrl = typeof h.pageURL === "string" ? h.pageURL : "";
    const width = Number(h.imageWidth), height = Number(h.imageHeight);
    if (!url || !pageUrl || !(width > 0) || !(height > 0)) continue;
    const tags = typeof h.tags === "string" ? stripHtml(h.tags.replace(/,/g, " "), 300) : "";
    const user = typeof h.user === "string" ? stripHtml(h.user, 80) : "";
    out.push({
      source: "pixabay", title: tags || `Pixabay image ${String(h.id ?? "")}`, url, width, height, mime: mimeOf(url), licence: LICENCE,
      credit: `Image by ${user || "Pixabay"} on Pixabay, ${LICENCE}, ${pageUrl}`.slice(0, 400), pageUrl, text: tags,
    });
  }
  return out;
}
