import type pg from "pg";
import { FX_SOURCES, fxRefreshDue, parseFxAnswer, rateInRange, type FxMeta } from "@/server/core/fx-rate";
import { recordAudit } from "@/server/db/audit";
import { getSetting, setSessionSettings } from "@/server/db/settings";
import { safeFetch } from "@/server/providers/net/safe-fetch";

// The daily rupee-rate refresh (owner 2026-11-14): no AI, no browser, no account. A plain request to a free public rate service
// through the app's safe fetcher (public hosts only, no redirects, a short timeout), the answer size-capped and checked against
// the documented shape and a believable range; a second service is the backup. A failed refresh keeps the last good rate.

export type FxFetcher = (url: string) => Promise<{ status: number; text: string }>;
export type FxResult = { ok: true; rate: number; source: string; rateDate: string } | { ok: false; error: string };

const MAX_BYTES = 20_000;
const FAILED = "No rate service gave a usable answer. The last rate is kept.";

/** The body as text, read in pieces and stopped just past `max` bytes (the caller refuses a body over the cap), so a huge answer is never held whole. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const dec = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out;
}

/** The production fetcher: safeFetch in indirect mode, no redirects, 10 s, the body read as text and capped. */
export const safeFxFetcher: FxFetcher = async (url) => {
  const res = await safeFetch(url, { redirect: "manual", headers: { accept: "application/json" } }, { mode: "indirect", maxRedirects: 0, timeoutMs: 10_000 });
  return { status: res.status, text: await readCapped(res, MAX_BYTES) };
};

/** Asks each service in turn; the first usable, in-range answer wins. */
export async function refreshInrRate(db: pg.Pool, fetcher: FxFetcher, now: Date = new Date()): Promise<FxResult> {
  for (const src of FX_SOURCES) {
    try {
      const { status, text } = await fetcher(src.url);
      if (status !== 200 || text.length > MAX_BYTES) continue;
      const got = parseFxAnswer(src.id, text);
      if (!got || !rateInRange(got.rate)) continue;
      const meta: FxMeta = { source: src.id, rateDate: got.rateDate, fetchedAt: now.toISOString() };
      // Both keys in one transaction (display.inr_rate and display.inr_meta are not safety keys; the same pattern as the backup result).
      await setSessionSettings(
        db,
        [{ key: "display.inr_rate", value: got.rate }, { key: "display.inr_meta", value: meta }],
        async (client, key, c) => {
          if (key === "display.inr_rate" && c.old !== c.new) await recordAudit(client, "setting.changed", { setting: key, from: c.old, to: c.new, source: src.id });
        },
      );
      return { ok: true, rate: got.rate, source: src.id, rateDate: got.rateDate };
    } catch {
      // this service is down or refused: try the next one
    }
  }
  return { ok: false, error: FAILED };
}

/** Worker hook: at most one check every few minutes; fetches once per IST day from 09:00 when automatic; after a failure waits an hour. Never throws. */
export function throttledFxRate(db: pg.Pool, opts: { fetcher?: FxFetcher; now?: () => number; everyMs?: number } = {}): () => Promise<void> {
  const clock = opts.now ?? Date.now;
  const every = opts.everyMs ?? 5 * 60_000;
  let lastCheck = -Infinity;
  let lastFailure = -Infinity;
  let running = false;
  return async () => {
    const t = clock();
    if (running || t - lastCheck < every || t - lastFailure < 3_600_000) return;
    lastCheck = t;
    running = true;
    try {
      const [auto, meta] = await Promise.all([getSetting(db, "display.inr_auto"), getSetting(db, "display.inr_meta")]);
      if (!fxRefreshDue(new Date(t), (meta as FxMeta | null) ?? null, auto === true)) return;
      const r = await refreshInrRate(db, opts.fetcher ?? safeFxFetcher, new Date(t));
      if (!r.ok) lastFailure = t;
    } catch {
      lastFailure = t; // the next try is in an hour
    } finally {
      running = false;
    }
  };
}
