import type { PictureCandidate } from "@/server/core/picture-rank";

// Wikimedia Commons search (public MediaWiki API, no key). Pure: builds the URL and parses the JSON; the caller fetches.
// Only these licences are used: public domain, CC0, CC BY (credit kept). CC BY-SA, NC, ND, GFDL, unknown and empty are refused.

const API = "https://commons.wikimedia.org/w/api.php";
export const THUMB_WIDTH = 1280;
const MAX_CREDIT = 400;

export function commonsSearchUrl(query: string, limit: number): string {
  const p = new URLSearchParams({
    action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: String(limit),
    prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(THUMB_WIDTH), format: "json",
  });
  return `${API}?${p.toString()}`;
}

/** The licence's display name when it may be used, else null. A licence url that says share-alike/non-commercial/no-derivs overrides the name. */
export function allowedLicence(shortName: string, url?: string): string | null {
  const name = shortName.trim().replace(/\s+/g, " ");
  if (!name) return null;
  if (url && /creativecommons\.org\/licenses\/by-(sa|nc|nd)/i.test(url)) return null;
  const n = name.toLowerCase();
  const ok = /^(public domain|pd([- ][a-z0-9 -]*)?|pdm|cc0([ -]\d(\.\d)?)?|cc zero)$/.test(n) || /^cc[- ]by[- ]\d\.\d([ -][a-z]{2,3})?$/.test(n);
  return ok ? name : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function stripHtml(s: string, max: number): string {
  const text = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") { const cp = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) && cp > 31 && cp < 0x10ffff ? String.fromCodePoint(cp) : " "; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[\u0000-\u001f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, max);
}

const cleanTitle = (t: string) => t.replace(/^File:/i, "").replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/_/g, " ").trim();

/** "Title by Author, LICENCE, url", at most 400 characters (title and author are cut first). */
export function creditLine(a: { title: string; author: string; licence: string; pageUrl: string }): string {
  const author = stripHtml(a.author, 120) || "Unknown author";
  const title = cleanTitle(stripHtml(a.title, 200)).slice(0, 120);
  const tail = `, ${a.licence}, ${a.pageUrl}`;
  const head = `${title} by ${author}`;
  return (head.slice(0, Math.max(0, MAX_CREDIT - tail.length)) + tail).slice(0, MAX_CREDIT);
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const meta = (em: Record<string, unknown>, k: string): string => str(obj(em[k]).value);

/** Candidates from one API answer; pages with a refused or missing licence, or without usable numbers, are left out. Never throws. */
export function parseCommons(json: unknown): PictureCandidate[] {
  const pages = obj(obj(json).query).pages;
  if (pages === null || typeof pages !== "object") return [];
  const sorted = Object.values(pages as Record<string, unknown>).map(obj).sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const out: PictureCandidate[] = [];
  for (const p of sorted) {
    const ii = obj(Array.isArray(p.imageinfo) ? p.imageinfo[0] : undefined);
    const em = obj(ii.extmetadata);
    const licence = allowedLicence(meta(em, "LicenseShortName"), meta(em, "LicenseUrl") || undefined);
    const width = Number(ii.width), height = Number(ii.height);
    const url = str(ii.url), pageUrl = str(ii.descriptionurl), title = str(p.title);
    if (!licence || !url || !pageUrl || !title || !(width > 0) || !(height > 0)) continue;
    const thumb = str(ii.thumburl);
    const text = stripHtml(`${meta(em, "ImageDescription")} ${meta(em, "Categories").split("|").join(" ")}`, 1500);
    out.push({
      source: "wikimedia", title: cleanTitle(title), url: width > THUMB_WIDTH && thumb ? thumb : url, width, height, mime: str(ii.mime),
      licence, credit: creditLine({ title, author: meta(em, "Artist"), licence, pageUrl }), pageUrl, text,
    });
  }
  return out;
}
