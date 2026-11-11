import type { SafeFetch } from "../voice/eleven-types";
import { readCapped } from "../voice/elevenlabs";

/** A provider answer that was not 2xx. `status` lets a read-only check tell "no such job" (404) from "the provider is having trouble". */
export class HttpStatusError extends Error {
  constructor(readonly status: number, who: string) {
    super(`${who} answered ${status}; the outcome is unknown.`);
  }
}

/**
 * One GET after a job was submitted. Every failure is a plain Error: the job exists and may bill, so the outcome is unknown, never a refusal.
 * `max` caps the body (JSON answers are small; a video file passes a large cap).
 */
export async function getBytes(who: string, f: SafeFetch, url: string, headers: Record<string, string>, signal: AbortSignal, maxBytes?: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await f(url, { method: "GET", headers, signal }, { timeoutMs: 300_000, maxRedirects: 0 });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new Error(`${who} request failed after the job was submitted.`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpStatusError(res.status, who);
  }
  return readCapped(res, who, maxBytes);
}

/** JSON from a provider: anything unexpected is an unknown outcome. */
export function parseJson<T>(who: string, b: Buffer): T {
  try {
    return JSON.parse(b.toString("utf8")) as T;
  } catch {
    throw new Error(`${who} sent an answer that could not be read.`);
  }
}

/** A result file address: https only, no credentials, no port. The host check is the caller's (each provider serves files from its own hosts). */
export function plainHttpsUrl(who: string, raw: unknown): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`${who} returned an unusable file address.`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error(`${who} returned a file address that is not a plain https address.`);
  return u;
}
