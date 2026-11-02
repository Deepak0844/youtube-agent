import { safeFetch } from "@/server/providers/net/safe-fetch";

// SECURITY CONTROL: the only way the pictures stage touches the web. https only, exact host allow-list (checked on every
// redirect hop too), response capped while streaming, content type checked, no credentials in the address, a descriptive
// User-Agent. Pure of IO except the injected fetcher (production: safeFetch in indirect mode = public addresses only).

export const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
export const API_MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = "YTStudio/0.1 (https://github.com/Deepak0844/youtube-agent; personal local use)";
const MAX_HOPS = 2;

export const WIKIMEDIA_API_HOSTS = ["commons.wikimedia.org"] as const;
export const WIKIMEDIA_FILE_HOSTS = ["upload.wikimedia.org", "thumb.wikimedia.org"] as const;
export const PIXABAY_API_HOSTS = ["pixabay.com"] as const;
export const PIXABAY_FILE_HOSTS = ["pixabay.com", "cdn.pixabay.com"] as const;
export const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/i;
export const JSON_TYPE = /^application\/json$/i;

export type PictureFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type FetchRefusal = "host" | "redirects" | "status" | "type" | "too_big" | "network";
export type Fetched = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; reason: FetchRefusal };

export function hostAllowed(url: string, hosts: readonly string[]): URL | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port !== "" || !hosts.includes(u.hostname)) return null;
  return u;
}

export interface BoundedOptions { hosts: readonly string[]; maxBytes: number; accept: RegExp; signal: AbortSignal }

/**
 * Production fetcher: safeFetch in indirect mode (public addresses only). maxRedirects 0, so a redirect throws inside safeFetch
 * and the beat just gets no picture; the redirect loop in fetchBounded only matters for other fetchers (tests, a future change).
 */
export function createPictureFetcher(sf: typeof safeFetch = safeFetch): PictureFetcher {
  return (url, init) => sf(url, init, { mode: "indirect", maxRedirects: 0, timeoutMs: 30_000 });
}

/** GET with every refusal returned as a reason (never a thrown network error, never a URL or key in the reason). */
export async function fetchBounded(fetcher: PictureFetcher, rawUrl: string, o: BoundedOptions): Promise<Fetched> {
  let url = hostAllowed(rawUrl, o.hosts);
  for (let hop = 0; ; hop++) {
    if (!url) return { ok: false, reason: "host" };
    let res: Response;
    try {
      res = await fetcher(url.href, { method: "GET", redirect: "manual", signal: o.signal, headers: { "user-agent": USER_AGENT, accept: "image/jpeg,image/png,image/webp,application/json" } });
    } catch (e) {
      if (o.signal.aborted) throw o.signal.reason ?? e;
      return { ok: false, reason: "network" };
    }
    try {
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= MAX_HOPS) return { ok: false, reason: "redirects" };
        let next: string;
        try { next = new URL(loc, url).href; } catch { return { ok: false, reason: "host" }; }
        url = hostAllowed(next, o.hosts);
        continue;
      }
      if (!res.ok || !res.body) { await res.body?.cancel().catch(() => undefined); return { ok: false, reason: "status" }; }
      const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!o.accept.test(contentType)) { await res.body.cancel().catch(() => undefined); return { ok: false, reason: "type" }; }
      if (Number(res.headers.get("content-length") ?? 0) > o.maxBytes) { await res.body.cancel().catch(() => undefined); return { ok: false, reason: "too_big" }; }
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        n += chunk.length;
        if (n > o.maxBytes) { await res.body.cancel().catch(() => undefined); return { ok: false, reason: "too_big" }; }
        chunks.push(chunk);
      }
      return { ok: true, bytes: Buffer.concat(chunks), contentType };
    } catch (e) {
      if (o.signal.aborted) throw o.signal.reason ?? e;
      return { ok: false, reason: "network" };
    }
  }
}

/** Waits so two requests to the same host start at least minGapMs apart. Clock and sleep are injected; an aborted signal throws. */
export function createPacer(o: { minGapMs: number; now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> }): (host: string, signal: AbortSignal) => Promise<void> {
  const last = new Map<string, number>();
  return async (host, signal) => {
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    const prev = last.get(host);
    if (prev !== undefined) {
      const wait = prev + o.minGapMs - o.now();
      if (wait > 0) await o.sleep(wait, signal);
    }
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    last.set(host, o.now());
  };
}
