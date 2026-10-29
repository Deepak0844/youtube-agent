import { NotProcessedError } from "@/server/core/error-class";
import type { PriceRule } from "@/server/core/media-catalog";
import { BlockedAddressError } from "../net/safe-fetch";

/** safeFetch bound to the typed host; the per-call options (no redirects, 120 s) are passed here. */
export type SafeFetch = (url: string, init: RequestInit, opts: { timeoutMs: number; maxRedirects: number }) => Promise<Response>;

export interface CloudVoiceDeps {
  fetch: SafeFetch;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The registry price (getPriceRule); null = unpriced, refused. */
  price: PriceRule | null;
  budgetScopes: string[];
}

const MAX_BODY = 50 * 1024 * 1024;
const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export const isMpeg = (b: Buffer) => b.subarray(0, 3).toString("latin1") === "ID3" || (b.length > 1 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);

/** One POST. Fixed error text only: never the URL, the cause or the key. */
export async function post(name: string, f: SafeFetch, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    // maxRedirects 0: a redirect would re-POST (a second paid request); it surfaces as an error after send = unknown.
    res = await f(url, { ...init, method: "POST", signal }, { timeoutMs: 120_000, maxRedirects: 0 });
  } catch (err) {
    if (signal.aborted) throw signal.reason; // cancel/timeout after send: unknown
    if (err instanceof BlockedAddressError) throw new NotProcessedError(`${name} address was blocked.`);
    const code = (err as { cause?: { code?: unknown } })?.cause?.code;
    if (typeof code === "string" && BEFORE_SEND.has(code)) throw new NotProcessedError(`${name} could not be reached.`, { code });
    throw new Error(`${name} request failed after it was sent.`);
  }
  if (res.ok) return res;
  await res.body?.cancel().catch(() => undefined);
  // 4xx (not 408) = rejected before work (429 retried by the classifier, the rest permanent). 5xx may follow started work: unknown.
  if (res.status >= 400 && res.status <= 499 && res.status !== 408) throw new NotProcessedError(`${name} refused the request (${res.status}).`, { status: res.status });
  throw new Error(`${name} answered ${res.status}; the outcome is unknown.`);
}

/** Whole body, capped at 50 MB while streaming. A reset or truncated body is an unknown outcome. */
export async function readCapped(name: string, res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BODY) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`${name} response is over the 50 MB limit.`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${name} sent no body.`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${name} response is over the 50 MB limit.`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("50 MB")) throw err;
    throw new Error(`${name} response was cut off.`);
  }
  return Buffer.concat(chunks);
}
