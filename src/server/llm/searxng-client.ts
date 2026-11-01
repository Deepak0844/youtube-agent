import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { classifyAddress } from "@/server/core/net-policy";

/*
 * ADR note: why Draft's web search does not use safeFetch.
 * safeFetch treats the app's own services (including SearXNG's port, see local-services.ts) as BLOCKED destinations
 * on purpose, so a model-chosen URL can never reach them. Draft's search therefore could never reach a real SearXNG
 * through safeFetch (live evidence: "Blocked address 127.0.0.1 (own-service)"). Loosening safeFetch would weaken it for
 * every caller, so search gets this dedicated client instead, with a deliberately tiny scope:
 *  - the only host it will ever talk to is the operator-configured SEARXNG_URL (never anything the model supplies);
 *  - that host must resolve (every address) to loopback, private/LAN or Docker ranges: public, link-local and
 *    cloud-metadata addresses are refused, and the connection is pinned to the validated address (no second lookup);
 *  - the URL is built here: origin + "/search" with only q and format=json; GET only; redirects are an error;
 *  - 10 s timeout, 1 MB streamed body cap, JSON content type only, at most 10 trimmed results.
 * fetchPage (model-influenced URLs) still goes through safeFetch in indirect mode and still cannot reach SearXNG.
 */

export interface SearxResult { title: string; url: string; content: string }
export type SearxFetch = (url: string, init: { method: "GET"; redirect: "error"; signal: AbortSignal; headers: Record<string, string> }, pinned: string[]) => Promise<Response>;
export interface SearxOptions {
  fetchImpl?: SearxFetch;
  lookup?: (host: string) => Promise<string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const ALLOWED = new Set(["loopback", "private", "docker"]);
const MAX_QUERY = 300;
const MAX_RESULTS = 10;

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((r) => r.address);

const pinnedFetch: SearxFetch = async (url, init, addrs) => {
  const agent = new Agent({
    keepAliveTimeout: 1,
    connect: {
      lookup: (_h, options, cb) => {
        const list = addrs.map((address) => ({ address, family: isIP(address) }));
        if ((options as { all?: boolean } | null)?.all) (cb as unknown as (e: null, a: typeof list) => void)(null, list);
        else cb(null, list[0]!.address, list[0]!.family);
      },
    },
  });
  try {
    return (await undiciFetch(url, { ...init, dispatcher: agent })) as unknown as Response;
  } finally {
    void agent.close().catch(() => undefined);
  }
};

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("search response had no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("search response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const cap = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");

export async function searxSearch(searxUrl: string, query: string, opts: SearxOptions = {}): Promise<SearxResult[]> {
  if (typeof query !== "string" || query.trim() === "" || query.length > MAX_QUERY) throw new Error("query must be a short string");
  let base: URL;
  try { base = new URL(searxUrl); } catch { throw new Error("SearXNG URL is not a valid URL"); }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("SearXNG URL must be http or https");
  if (base.username || base.password) throw new Error("SearXNG URL must not contain credentials");
  const host = base.hostname.startsWith("[") ? base.hostname.slice(1, -1) : base.hostname;
  const addrs = isIP(host) !== 0 ? [host] : await (opts.lookup ?? defaultLookup)(host);
  if (addrs.length === 0) throw new Error("SearXNG host did not resolve");
  for (const a of addrs) {
    if (!ALLOWED.has(classifyAddress(a))) throw new Error(`SearXNG host must be local or private (got ${classifyAddress(a)} address)`);
  }
  const u = new URL("/search", base.origin);
  u.searchParams.set("q", query);
  u.searchParams.set("format", "json");

  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await (opts.fetchImpl ?? pinnedFetch)(u.toString(), { method: "GET", redirect: "error", signal, headers: { accept: "application/json" } }, addrs);
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  if (!/^application\/json\b/i.test(res.headers.get("content-type") ?? "")) throw new Error("search response was not JSON");
  const text = await readCapped(res, opts.maxBytes ?? 1_000_000);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("search response was not valid JSON"); }
  const list = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return [];
  const out: SearxResult[] = [];
  for (const r of list as Array<Record<string, unknown> | null>) {
    if (out.length >= MAX_RESULTS) break;
    if (!r || typeof r.url !== "string" || r.url.length > 2000) continue;
    out.push({ title: cap(r.title, 200), url: r.url, content: cap(r.content, 500) });
  }
  return out;
}
