import { AUDIT_EVENTS } from "@/server/core/audit-events";

// Pure helpers for the read-only audit page: query parsing, filter chips, time and detail text. No IO, no HTML.
// Everything returned is plain text; the page renders it through React's escaping and nothing else.

/** Largest cursor accepted. Row ids are bigserial, but 10^15 is far beyond any real log and stays an exact JS integer. */
export const MAX_CURSOR = 1_000_000_000_000_000;

const GROUP_LABELS: Record<string, string> = {
  setting: "Settings",
  key: "Keys",
  model: "Models",
  route: "Routing",
  google_app: "Google app",
  vault: "Vault",
  owner: "Owner",
  login: "Sign-in",
  password: "Password",
  totp: "Two-factor",
};

const groupOf = (event: string) => event.split(".")[0]!;

/** One chip per event family in the catalogue (the part before the first dot), in catalogue order. */
export const AUDIT_FILTERS: { id: string; label: string }[] = [
  ...new Set(Object.keys(AUDIT_EVENTS).map(groupOf)),
].map((id) => ({ id, label: GROUP_LABELS[id] ?? id }));

const FILTER_IDS = new Set(AUDIT_FILTERS.map((f) => f.id));

export interface AuditQuery {
  before: string | null;
  filter: string | null;
  /** True when a cursor was present but unusable, so the page can say it fell back to the newest entries. */
  ignored: boolean;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function parseAuditQuery(raw: { before?: string | string[]; event?: string | string[] }): AuditQuery {
  const b = first(raw.before);
  let before: string | null = null;
  let ignored = false;
  if (b !== undefined) {
    if (/^[1-9][0-9]{0,15}$/.test(b) && Number(b) <= MAX_CURSOR) before = b;
    else ignored = true;
  }
  const e = first(raw.event);
  const filter = e !== undefined && FILTER_IDS.has(e) ? e : null;
  return { before, filter, ignored };
}

/** The event prefix handed to listAudit for a chip. The dot keeps "key" from matching a future "keyboard.*". */
export const filterPrefix = (filter: string | null): string => (filter ? `${filter}.` : "");

export function auditHref(q: { filter?: string | null; before?: string | null }): string {
  const p = new URLSearchParams();
  if (q.filter) p.set("event", q.filter);
  if (q.before) p.set("before", q.before);
  const s = p.toString();
  return s ? `/settings/audit?${s}` : "/settings/audit";
}

export function relativeTime(then: Date, now: Date): string {
  const s = Math.floor((now.getTime() - then.getTime()) / 1000);
  if (s < 30) return "just now"; // also covers clock skew (negative)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) {
    const d = Math.floor(s / 86400);
    return d === 1 ? "1 day ago" : `${d} days ago`;
  }
  return `${then.getUTCDate()} ${then.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${then.getUTCFullYear()}`;
}

const p2 = (n: number) => String(n).padStart(2, "0");
export const utcStamp = (d: Date): string =>
  `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts to `max` user-perceived characters (never mid-grapheme, so Indic conjuncts and emoji stay whole) and adds an ellipsis. */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s; // fewer code units than the limit means fewer graphemes too
  let out = "";
  let n = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (n === max) return `${out}…`;
    out += segment;
    n++;
  }
  return out;
}

const MAX_PAIRS = 8;
const KEY_CHARS = 40;
const VALUE_CHARS = 120;

function scalar(v: unknown, depth: number, seen: Set<object>): string {
  switch (typeof v) {
    case "string":
      return v;
    case "number":
    case "boolean":
    case "bigint":
      return String(v);
    case "object": {
      if (v === null) return "–";
      if (seen.has(v) || depth > 3) return "…";
      seen.add(v);
      try {
        if (Array.isArray(v)) return v.slice(0, 6).map((x) => scalar(x, depth + 1, seen)).join(", ");
        return Object.keys(v)
          .slice(0, 6)
          .map((k) => `${k}: ${scalar((v as Record<string, unknown>)[k], depth + 1, seen)}`)
          .join(", ");
      } catch {
        return "…";
      } finally {
        seen.delete(v);
      }
    }
    default:
      return "–";
  }
}

/** Detail as at most 8 short key/value text pairs. Never JSON, never HTML; control characters become spaces. */
export function describeDetail(detail: unknown): { pairs: { key: string; value: string }[]; hidden: number } {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return { pairs: [], hidden: 0 };
  const keys = Object.keys(detail);
  const clean = (s: string, max: number) => truncateText(s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim(), max);
  const pairs = keys.slice(0, MAX_PAIRS).map((k) => {
    let v: unknown;
    try {
      v = (detail as Record<string, unknown>)[k];
    } catch {
      v = null;
    }
    return { key: clean(k, KEY_CHARS), value: clean(scalar(v, 0, new Set()), VALUE_CHARS) };
  });
  return { pairs, hidden: Math.max(0, keys.length - MAX_PAIRS) };
}
