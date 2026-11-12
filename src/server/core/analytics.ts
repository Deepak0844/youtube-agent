// Pure helpers for the analytics pull: Google URLs, response parsing, and the per-beat drop-off. No IO.
export const DATA_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
export const ANALYTICS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
/** Below this many shorts with a curve, per-beat numbers are noise (Roadmap Phase 5). */
export const MIN_SHORTS_FOR_SIGNAL = 10;
export const YT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const statsUrl = (ids: string[]): string => `${DATA_VIDEOS_URL}?part=statistics,status&maxResults=50&id=${ids.map(encodeURIComponent).join(",")}`;

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
/** Totals for one video: views, estimatedMinutesWatched, averageViewPercentage. */
export const totalsUrl = (videoId: string, start: string, end: string): string =>
  `${ANALYTICS_URL}?${q({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "views,estimatedMinutesWatched,averageViewPercentage", filters: `video==${videoId}` })}`;
/** Audience retention curve for one video. */
export const retentionUrl = (videoId: string, start: string, end: string): string =>
  `${ANALYTICS_URL}?${q({ ids: "channel==MINE", startDate: start, endDate: end, dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio", filters: `video==${videoId}` })}`;

/** Channel totals for a date range: subscribers gained and lost (no video filter: the whole channel). */
export const channelSubsUrl = (start: string, end: string): string =>
  `${ANALYTICS_URL}?${q({ ids: "channel==MINE", startDate: start, endDate: end, metrics: "subscribersGained,subscribersLost" })}`;

/** The 7-day window a pull on `day` (YYYY-MM-DD) covers: the 7 days ending 2 days earlier, since Analytics data lags. */
export function subsWindow(day: string): { start: string; end: string } {
  const at = (back: number) => new Date(Date.parse(`${day}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  return { start: at(8), end: at(2) };
}

export interface Stats { views: number | null; likes: number | null; comments: number | null; /** status.privacyStatus as YouTube reports it now, or null. */ privacy?: string | null }
const num = (v: unknown): number | null => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** videos.list part=statistics,status -> stats (and privacy now) by video id. A hidden like count simply stays null. */
export function parseStats(body: unknown): Map<string, Stats> {
  const out = new Map<string, Stats>();
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return out;
  for (const it of items as Array<{ id?: unknown; statistics?: Record<string, unknown>; status?: { privacyStatus?: unknown } }>) {
    if (typeof it?.id !== "string" || !YT_ID.test(it.id)) continue;
    const s = it.statistics ?? {};
    const p = it.status?.privacyStatus;
    out.set(it.id, { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), privacy: typeof p === "string" && /^[a-z]{1,20}$/.test(p) ? p : null });
  }
  return out;
}

/**
 * A scheduled release has happened when the owner approved "private, publish at T", T has passed, and YouTube now says public.
 * `meta` is the newest publish choice (metadata body).
 */
export function releasedNow(meta: unknown, privacy: string | null | undefined, nowMs: number): boolean {
  const m = meta as { visibility?: unknown; publish_at?: unknown } | null;
  if (privacy !== "public" || m?.visibility !== "private" || typeof m.publish_at !== "string") return false;
  const at = Date.parse(m.publish_at);
  return Number.isFinite(at) && at <= nowMs;
}

export interface Totals { views: number | null; minutesWatched: number | null; avgViewPct: number | null }
/** Analytics totals row, matched to its column headers by name. No row (a brand new video) -> all null. */
export function parseTotals(body: unknown): Totals {
  const b = body as { columnHeaders?: Array<{ name?: unknown }>; rows?: unknown[][] };
  const row = Array.isArray(b?.rows) ? b.rows[0] : undefined;
  const at = (name: string) => {
    const i = Array.isArray(b?.columnHeaders) ? b.columnHeaders.findIndex((h) => h?.name === name) : -1;
    return i >= 0 && Array.isArray(row) ? num(row[i]) : null;
  };
  return { views: at("views"), minutesWatched: at("estimatedMinutesWatched"), avgViewPct: at("averageViewPercentage") };
}

export interface Subs { gained: number | null; lost: number | null }
/** Channel subscriber totals, matched by column name. No row -> both null. */
export function parseSubs(body: unknown): Subs {
  const b = body as { columnHeaders?: Array<{ name?: unknown }>; rows?: unknown[][] };
  const row = Array.isArray(b?.rows) ? b.rows[0] : undefined;
  const at = (name: string) => {
    const i = Array.isArray(b?.columnHeaders) ? b.columnHeaders.findIndex((h) => h?.name === name) : -1;
    return i >= 0 && Array.isArray(row) ? num(row[i]) : null;
  };
  return { gained: at("subscribersGained"), lost: at("subscribersLost") };
}

export type Curve = Array<[ratio: number, watch: number]>;
/** Retention rows -> clean, sorted curve (ratio 0..1, watch ratio >= 0; may exceed 1 through replays). */
export function parseRetention(body: unknown): Curve {
  const rows = (body as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: Curve = [];
  for (const r of rows) {
    const x = Array.isArray(r) ? num(r[0]) : null;
    const y = Array.isArray(r) ? num(r[1]) : null;
    if (x !== null && y !== null && x <= 1) out.push([x, y]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Watch ratio at `ratio` by straight-line interpolation; null when the curve does not reach that far. */
export function retentionAt(curve: Curve, ratio: number): number | null {
  if (curve.length === 0 || ratio < curve[0]![0] || ratio > curve[curve.length - 1]![0]) return null;
  for (let i = 0; i < curve.length; i++) {
    const [x, y] = curve[i]!;
    if (x === ratio) return y;
    const next = curve[i + 1];
    if (next && x < ratio && ratio < next[0]) return y + ((next[1] - y) * (ratio - x)) / (next[0] - x);
  }
  return null;
}

export interface BeatSpan { id: string; from: number; to: number }
/**
 * Where each beat sits in the video as a share (0..1). With scene timings (startMs/durationMs per beat) those are used;
 * otherwise each beat gets a share of the length of its spoken line.
 */
export function beatSpans(beats: unknown, scenes?: unknown): BeatSpan[] {
  const list = Array.isArray(beats) ? (beats as Array<{ id?: unknown; text?: unknown }>) : [];
  const ids = list.map((b, i) => (typeof b?.id === "string" && b.id ? b.id : `beat-${i + 1}`));
  if (ids.length === 0) return [];
  const sc = Array.isArray((scenes as { scenes?: unknown })?.scenes) ? (scenes as { scenes: Array<{ beat?: unknown; startMs?: unknown; durationMs?: unknown }> }).scenes : [];
  const win = new Map<string, [number, number]>();
  for (const s of sc) {
    if (typeof s.beat !== "string" || typeof s.startMs !== "number" || typeof s.durationMs !== "number") continue;
    const w = win.get(s.beat) ?? [Infinity, 0];
    win.set(s.beat, [Math.min(w[0], s.startMs), Math.max(w[1], s.startMs + s.durationMs)]);
  }
  const total = Math.max(0, ...[...win.values()].map((w) => w[1]));
  if (total > 0 && ids.every((id) => win.has(id))) return ids.map((id) => ({ id, from: win.get(id)![0] / total, to: win.get(id)![1] / total }));
  const weights = list.map((b) => Math.max(1, typeof b?.text === "string" ? b.text.length : 1));
  const sum = weights.reduce((a, b) => a + b, 0);
  let at = 0;
  return ids.map((id, i) => {
    const from = at;
    at += weights[i]! / sum;
    return { id, from, to: i === ids.length - 1 ? 1 : at };
  });
}

export interface DropOff { retentionAt10: number | null; biggestDropBeat: string | null; biggestDrop: number | null }
/** "Retention at 10%" and the beat where the audience fell most (watch ratio at its start minus at its end). */
export function dropOff(curve: Curve, spans: BeatSpan[]): DropOff {
  let best: { id: string; drop: number } | null = null;
  for (const s of spans) {
    const a = retentionAt(curve, s.from);
    const b = retentionAt(curve, s.to);
    if (a === null || b === null) continue;
    if (best === null || a - b > best.drop) best = { id: s.id, drop: a - b };
  }
  return { retentionAt10: retentionAt(curve, 0.1), biggestDropBeat: best?.id ?? null, biggestDrop: best ? Math.round(best.drop * 1000) / 1000 : null };
}

/** True when there are too few shorts with a curve for the numbers to mean much. */
export const isNoise = (shortsWithCurve: number): boolean => shortsWithCurve < MIN_SHORTS_FOR_SIGNAL;
