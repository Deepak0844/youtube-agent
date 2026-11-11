// Page numbers for long lists (spec 2026-11-12 §4.6.4). The page and filters live in the URL so back and refresh keep
// the place. Bad input never errors: it falls back to page 1 / size 25, and a page past the end shows the last page.

export const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_SIZE = 25;

export type PageReq = { page: number; size: number; limit: number; offset: number };
export type Paged<T> = { rows: T[]; total: number };

const one = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const make = (page: number, size: number): PageReq => ({ page, size, limit: size, offset: (page - 1) * size });

export function parsePage(raw: Record<string, unknown>): PageReq {
  const p = one(raw.page);
  const page = p && /^[1-9][0-9]{0,5}$/.test(p) ? Number(p) : 1;
  const s = Number(one(raw.size));
  const size = (PAGE_SIZES as readonly number[]).includes(s) ? s : DEFAULT_SIZE;
  return make(page, size);
}

export function clampPage(req: PageReq, total: number): PageReq {
  const last = Math.max(1, Math.ceil(total / req.size));
  return req.page > last ? make(last, req.size) : req;
}

export function pageLabel(page: number, size: number, total: number): string {
  if (total === 0) return "0 of 0";
  const from = (page - 1) * size + 1;
  return `${from}–${Math.min(page * size, total)} of ${total}`;
}

/** First, last, current ±1; a gap of two or more pages becomes "…". */
export function pageLinks(page: number, totalPages: number): Array<number | "…"> {
  const keep = new Set([1, totalPages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= totalPages));
  const nums = [...keep].sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  for (const n of nums) {
    const prev = out.at(-1);
    if (typeof prev === "number" && n - prev === 2) out.push(prev + 1);
    else if (typeof prev === "number" && n - prev > 2) out.push("…");
    out.push(n);
  }
  return out;
}

/**
 * The link for a changed list view. Changing anything other than page/size drops the page (back to page 1).
 * Page 1 and the default size are left out; `undefined` removes a key.
 */
export function pageHref(path: string, params: Record<string, string | undefined>, change: Record<string, string | number | undefined>): string {
  const next: Record<string, string | undefined> = { ...params };
  if (Object.keys(change).some((k) => k !== "page" && k !== "size")) delete next.page;
  for (const [k, v] of Object.entries(change)) next[k] = v === undefined ? undefined : String(v);
  if (next.page === "1") delete next.page;
  if (next.size === String(DEFAULT_SIZE)) delete next.size;
  const q = new URLSearchParams();
  const ordered = ["page", "size", ...Object.keys(next).filter((k) => k !== "page" && k !== "size")];
  for (const k of ordered) {
    const v = next[k];
    if (v !== undefined && v !== "") q.set(k, v);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function parseSort<T extends string>(raw: Record<string, unknown>, allowed: readonly T[], fallback: T): { sort: T; dir: "asc" | "desc" } {
  const s = one(raw.sort);
  const sort = (allowed as readonly string[]).includes(s ?? "") ? (s as T) : fallback;
  return { sort, dir: one(raw.dir) === "asc" ? "asc" : "desc" };
}
