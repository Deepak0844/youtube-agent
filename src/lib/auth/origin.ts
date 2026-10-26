import { isAllowedHost, parseAllowedHosts } from "./policy";
import { readSessionCookie } from "./session-cookie";

// CSRF guard for route handlers (Server Actions use Next's built-in Origin-vs-Host check instead).
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const forbidden = (why: string) => Response.json({ error: "forbidden", reason: why }, { status: 403, headers: { "cache-control": "no-store" } });

/** Host header must be on the allow-list (for routes the proxy matcher skips). Null = ok. */
export function assertAllowedHost(request: Request): Response | null {
  return isAllowedHost(request.headers.get("host"), parseAllowedHosts(process.env.ALLOWED_HOSTS)) ? null : forbidden("host");
}

/**
 * State-changing requests need an Origin whose host is allow-listed AND equals the Host header. A missing Origin is
 * refused when the session cookie is present; with no cookie it is accepted only via a same-origin Referer + Sec-Fetch-Site.
 * Returns null when the request may proceed, else a 403 Response.
 */
export function assertSameOrigin(request: Request): Response | null {
  if (SAFE.has(request.method.toUpperCase())) return null;
  const hostErr = assertAllowedHost(request);
  if (hostErr) return hostErr;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const allowed = parseAllowedHosts(process.env.ALLOWED_HOSTS);
  const sameHost = (u: string | null): boolean => {
    if (!u) return false;
    try {
      const url = new URL(u);
      return (url.protocol === "http:" || url.protocol === "https:") && isAllowedHost(url.host, allowed) && url.host.toLowerCase() === host;
    } catch {
      return false;
    }
  };

  const origin = request.headers.get("origin");
  if (origin !== null) return sameHost(origin) ? null : forbidden("origin");
  if (readSessionCookie(request.headers.get("cookie"))) return forbidden("origin_missing");
  if (request.headers.get("sec-fetch-site") === "same-origin" && sameHost(request.headers.get("referer"))) return null;
  return forbidden("origin_missing");
}
