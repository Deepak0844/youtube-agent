import { CLIP_MAX_BYTES, CLIP_MIN_HEIGHT, type ClipCandidate } from "@/server/core/clip-rank";
import { hostAllowed, PIXABAY_API_HOSTS, PIXABAY_FILE_HOSTS } from "./picture-download";
import { stripHtml } from "./wikimedia";

// Pixabay video search for the pictures stage (same key as the image search; it goes only into the URL built here).
// Every clip is under the Pixabay Content License (the answer carries no licence text, so it is stamped here).
// Only a file on the existing Pixabay file allow-list is taken; a rendition hosted elsewhere is skipped.
const LICENCE = "Pixabay Content License";

export function pixabayVideoSearchUrl(query: string, key: string, perPage: number): string {
  const p = new URLSearchParams({ key, q: query, safesearch: "true", per_page: String(perPage) });
  return `https://pixabay.com/api/videos/?${p.toString()}`;
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The smallest rendition that is at least 720 px high, within the size cap and on an allowed host; null when none. */
export function chooseRendition(videos: unknown): { url: string; width: number; height: number; bytes: number } | null {
  let best: { url: string; width: number; height: number; bytes: number } | null = null;
  for (const name of ["large", "medium", "small", "tiny"]) {
    const r = obj(obj(videos)[name]);
    const file = hostAllowed(typeof r.url === "string" ? r.url : "", PIXABAY_FILE_HOSTS);
    const width = Number(r.width), height = Number(r.height), bytes = Number(r.size);
    if (!file || !/\.mp4$/i.test(file.pathname) || !(width > 0) || !(height >= CLIP_MIN_HEIGHT) || !(bytes > 0) || bytes > CLIP_MAX_BYTES) continue;
    if (!best || bytes < best.bytes) best = { url: file.href, width, height, bytes };
  }
  return best;
}

export function parsePixabayVideos(json: unknown): ClipCandidate[] {
  const hits = obj(json).hits;
  if (!Array.isArray(hits)) return [];
  const out: ClipCandidate[] = [];
  for (const raw of hits) {
    const h = obj(raw);
    const rend = chooseRendition(h.videos);
    const durationS = Number(h.duration);
    if (!rend || !(durationS > 0)) continue;
    const page = hostAllowed(typeof h.pageURL === "string" ? h.pageURL : "", PIXABAY_API_HOSTS);
    const pageUrl = page ? page.href : null;
    const tags = typeof h.tags === "string" ? stripHtml(h.tags.replace(/,/g, " "), 300) : "";
    const user = typeof h.user === "string" ? stripHtml(h.user, 80) : "";
    out.push({
      title: tags || `Pixabay video ${String(h.id ?? "")}`, ...rend, durationS, licence: LICENCE,
      credit: `Video by ${user || "Pixabay"} on Pixabay, ${LICENCE}${pageUrl ? `, ${pageUrl}` : ""}`.slice(0, 400), pageUrl, text: tags,
    });
  }
  return out;
}
