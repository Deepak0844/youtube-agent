// Competitor research (Phase 6 piece 6.4): pure parsing, scoring and outlier rules. No IO. Everything an API returns is untrusted
// data: ids are format-checked, numbers are coerced, text is trimmed and stripped of markup. Parity with the old agent/research.py.
// Trend sources are Hacker News and Wikimedia only (no Reddit).

/** The old app's own margin under YouTube's 100 search.list calls a day. */
export const SEARCH_DAILY_MAX = 90;
export const SEARCH_DAILY_SHOWN = 100;
/** Research rows not refreshed within this many days are deleted (YouTube API data-retention rule). */
export const RETENTION_DAYS = 30;
export const MIN_SCORE = 30;
export const OUTLIER_MULTIPLE = 3;
export const OUTLIER_MAX_AGE_DAYS = 14;
export const OUTLIER_MIN_VIDEOS = 5;

export const canSearch = (usedToday: number): boolean => usedToday < SEARCH_DAILY_MAX;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const CHANNEL_ID = /^UC[\w-]{20,}$/;
const STOP = new Set(["the", "and", "for", "you", "your", "with", "this", "that", "how", "why", "what", "are", "from", "have", "shorts", "short", "video", "videos"]);
const DAY_MS = 86400_000;

/** Plain one-line text: markup and control characters removed, length capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/<[^>]*>/g, "").replace(/[<>\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const count = (v: unknown): number => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};
const items = (body: unknown): unknown[] => {
  const i = (body as { items?: unknown } | null)?.items;
  return Array.isArray(i) ? i : [];
};

export const words = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z0-9+#]{2,}/g) ?? []).filter((w) => !STOP.has(w));

export function isoDurationSeconds(s: unknown): number {
  const m = typeof s === "string" ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s) : null;
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** A channel's uploads playlist id is its channel id with UC swapped for UU. */
export const uploadsPlaylistId = (channelId: string): string | null => (channelId.startsWith("UC") ? `UU${channelId.slice(2)}` : null);

export interface ChannelInfo { id: string; title: string; description: string; language: string; subs: number }
export function parseChannels(body: unknown): ChannelInfo[] {
  const out: ChannelInfo[] = [];
  for (const it of items(body) as Array<{ id?: unknown; snippet?: Record<string, unknown>; statistics?: Record<string, unknown> }>) {
    if (typeof it?.id !== "string" || !ID.test(it.id)) continue;
    out.push({
      id: it.id, title: cleanText(it.snippet?.title, 200), description: cleanText(it.snippet?.description, 300),
      language: cleanText(it.snippet?.defaultLanguage, 12), subs: count(it.statistics?.subscriberCount),
    });
  }
  return out;
}

export interface VideoInfo { videoId: string; channelId: string; title: string; tags: string[]; publishedAt: Date | null; views: number; durationS: number }
export function parseVideos(body: unknown): VideoInfo[] {
  const out: VideoInfo[] = [];
  type Raw = { id?: unknown; snippet?: Record<string, unknown>; statistics?: Record<string, unknown>; contentDetails?: Record<string, unknown> };
  for (const it of items(body) as Raw[]) {
    const ch = it?.snippet?.channelId;
    if (typeof it?.id !== "string" || !ID.test(it.id) || typeof ch !== "string" || !ID.test(ch) || !it.statistics) continue;
    const at = typeof it.snippet?.publishedAt === "string" ? new Date(it.snippet.publishedAt) : null;
    const tags = Array.isArray(it.snippet?.tags) ? (it.snippet.tags as unknown[]).map((t) => cleanText(t, 40).toLowerCase()).filter(Boolean).slice(0, 20) : [];
    out.push({
      videoId: it.id, channelId: ch, title: cleanText(it.snippet?.title, 300), tags, publishedAt: at && !Number.isNaN(at.getTime()) ? at : null,
      views: count(it.statistics.viewCount), durationS: isoDurationSeconds(it.contentDetails?.duration),
    });
  }
  return out;
}

export function parseSearchChannelIds(body: unknown): string[] {
  const out: string[] = [];
  for (const it of items(body) as Array<{ snippet?: { channelId?: unknown } }>) {
    const id = it?.snippet?.channelId;
    if (typeof id === "string" && ID.test(id)) out.push(id);
  }
  return out;
}

/** playlistItems.list -> video ids. */
export function parsePlaylistVideoIds(body: unknown): string[] {
  const out: string[] = [];
  for (const it of items(body) as Array<{ contentDetails?: { videoId?: unknown } }>) {
    const id = it?.contentDetails?.videoId;
    if (typeof id === "string" && ID.test(id)) out.push(id);
  }
  return out;
}

export interface Profile { language: string; keywords: string[] }
/** Top keywords across the owner's own recent uploads (titles and tags). */
export function profileFrom(uploads: VideoInfo[], language: string): Profile {
  const tally = new Map<string, number>();
  for (const v of uploads) for (const w of [...words(v.title), ...v.tags]) tally.set(w, (tally.get(w) ?? 0) + 1);
  return { language, keywords: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w]) => w) };
}

/** Search phrases from the profile's own keywords, two at a time (no model needed). */
export function queriesFrom(p: Profile): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.min(8, p.keywords.length); i += 2) out.push(p.keywords.slice(i, i + 2).join(" "));
  return out;
}

/** 0-100 and a plain reason: topic overlap, language, size band, upload cadence, short-form share. */
export function scoreCandidate(c: ChannelInfo, profile: Profile, ownSubs: number, recent: VideoInfo[], now: Date): { score: number; reason: string } {
  const why: string[] = [];
  const have = new Set(profile.keywords);
  const overlap = new Set(words(`${c.title} ${c.description}`).filter((w) => have.has(w))).size;
  let s = 35 * Math.min(1, overlap / 3);
  why.push(`topic overlap ${overlap} word(s)`);
  const langOk = !c.language || c.language.split("-")[0] === profile.language;
  if (langOk) s += 15;
  why.push(langOk ? "language matches" : `language ${c.language}`);
  const floor = Math.max(ownSubs, 100);
  const inBand = c.subs >= floor * 0.2 && c.subs <= floor * 50;
  if (inBand) s += 20;
  why.push(`${c.subs.toLocaleString("en-US")} subscribers${inBand ? "" : " (outside your size band)"}`);
  const cutoff = now.getTime() - 90 * DAY_MS;
  const active = recent.filter((v) => v.publishedAt && v.publishedAt.getTime() >= cutoff);
  if (active.length >= 4) s += 15;
  why.push(`${active.length} upload(s) in 90 days`);
  const share = active.length ? active.filter((v) => v.durationS > 0 && v.durationS <= 180).length / active.length : 0;
  s += 15 * share;
  why.push(`${Math.round(share * 100)}% short-form`);
  if (overlap === 0) s = Math.min(s, 20); // off topic never makes the list
  return { score: Math.round(s * 10) / 10, reason: why.join("; ") };
}

export interface StoredVideo { videoId: string; competitorId: string; title: string; publishedAt: Date | null; views: number }
export interface Outlier { videoId: string; competitorId: string; title: string; views: number; xMedian: number; ageDays: number }

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Young videos whose views are at least 3x their own channel's median. Channels with fewer than 5 videos are skipped. */
export function outliers(videos: StoredVideo[], now: Date, multiple = OUTLIER_MULTIPLE, maxAgeDays = OUTLIER_MAX_AGE_DAYS): Outlier[] {
  const by = new Map<string, StoredVideo[]>();
  for (const v of videos) by.set(v.competitorId, [...(by.get(v.competitorId) ?? []), v]);
  const out: Outlier[] = [];
  for (const rows of by.values()) {
    if (rows.length < OUTLIER_MIN_VIDEOS) continue;
    const med = median(rows.map((r) => r.views)) || 1;
    for (const r of rows) {
      if (!r.publishedAt) continue;
      const ageDays = Math.floor((now.getTime() - r.publishedAt.getTime()) / DAY_MS);
      if (ageDays > maxAgeDays || r.views < multiple * med) continue;
      out.push({ videoId: r.videoId, competitorId: r.competitorId, title: r.title, views: r.views, xMedian: Math.round((r.views / med) * 10) / 10, ageDays: Math.max(0, ageDays) });
    }
  }
  return out.sort((a, b) => b.xMedian - a.xMedian);
}

// ---- trend sources: Hacker News (Firebase API) and Wikimedia most-read. No Reddit. ----
export interface TrendItem { source: "hackernews" | "wikimedia"; itemKey: string; topic: string; signal: number; url: string }

export const HN_TOP_URL = "https://hacker-news.firebaseio.com/v0/topstories.json";
export const hnItemUrl = (id: number): string => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

export function parseHnTopIds(body: unknown, n: number): number[] {
  return Array.isArray(body) ? body.filter((x): x is number => Number.isInteger(x) && x > 0).slice(0, n) : [];
}
/** The link is always built by us from the id; the story's own url is never followed or shown. */
export function parseHnItem(body: unknown, id: number): TrendItem | null {
  const b = body as { title?: unknown; score?: unknown } | null;
  const topic = cleanText(b?.title, 300);
  if (!topic) return null;
  return { source: "hackernews", itemKey: String(id), topic, signal: count(b?.score), url: `https://news.ycombinator.com/item?id=${id}` };
}

/** Most-read pages of the English Wikipedia for the UTC day before `now`. */
export function wikimediaUrl(now: Date): string {
  const d = new Date(now.getTime() - DAY_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}
const ARTICLE = /^[^\s:/?#]{1,150}$/; // no namespaces (Special:, Wikipedia:), no slashes or query bits
export function parseWikimediaTop(body: unknown, n: number): TrendItem[] {
  const arts = (body as { items?: Array<{ articles?: unknown }> } | null)?.items?.[0]?.articles;
  if (!Array.isArray(arts)) return [];
  const out: TrendItem[] = [];
  for (const a of arts as Array<{ article?: unknown; views?: unknown }>) {
    if (typeof a?.article !== "string" || a.article === "Main_Page" || !ARTICLE.test(a.article)) continue;
    const topic = cleanText(a.article.replace(/_/g, " "), 200);
    if (!topic) continue;
    out.push({ source: "wikimedia", itemKey: a.article, topic, signal: count(a.views), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.article)}` });
    if (out.length >= n) break;
  }
  return out;
}

/** Owner input for "add by @handle": a UC channel id or a @handle. */
export function parseChannelRef(raw: string): { kind: "id"; id: string } | { kind: "handle"; handle: string } | null {
  const s = raw.trim();
  if (CHANNEL_ID.test(s)) return { kind: "id", id: s };
  return /^@[A-Za-z0-9._-]{3,60}$/.test(s) ? { kind: "handle", handle: s } : null;
}
