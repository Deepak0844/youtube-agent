// Tests a provider key with ONE free read-only request through safeFetch. Returns a verdict and nothing else: the response
// body is cancelled unread, redirects are never followed (the key must not travel), and errors are swallowed without being
// logged with their text (it could contain the request URL, which for Pixabay carries the key).
import { keyTestRequest, statusToResult, type KeyTestResult, type ProviderId } from "@/server/core/provider-keys";
import { safeFetch } from "@/server/providers/net/safe-fetch";

export type KeyFetcher = (url: string, init: RequestInit, opts: { timeoutMs: number; maxRedirects: number }) => Promise<Response>;

const defaultFetcher: KeyFetcher = (url, init, o) => safeFetch(url, init, { mode: "indirect", ...o });

export async function runKeyTest(id: ProviderId, key: string, opts: { fetcher?: KeyFetcher; timeoutMs?: number } = {}): Promise<KeyTestResult> {
  const req = keyTestRequest(id, key);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const res = await (opts.fetcher ?? defaultFetcher)(req.url, { method: "GET", headers: req.headers, redirect: "manual" }, { timeoutMs, maxRedirects: 0 });
    await res.body?.cancel().catch(() => undefined);
    return statusToResult(res.status);
  } catch {
    return "unreachable";
  }
}
