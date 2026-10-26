import { NextResponse, type NextRequest } from "next/server";
import { isAllowedHost, isApiPath, isPublicPath, parseAllowedHosts, safeNext } from "@/lib/auth/policy";
import { readSessionCookie } from "@/lib/auth/session-cookie";

// Next 16 "proxy" (formerly middleware). Two jobs only, both cheap and optimistic:
//  1. Host allow-list (DNS-rebinding / forged Host): anything else gets 400.
//  2. No session cookie on a non-public path: pages 307 to /login?next=..., /api/* gets 401 JSON.
// The cookie is NOT validated here (no DB in the proxy); requireOwner()/requireOwnerApi() do the real check.
// Server Functions are POSTs to the page route, so every action must still authenticate itself.

const allowedHosts = parseAllowedHosts(process.env.ALLOWED_HOSTS);

export function proxy(request: NextRequest): NextResponse {
  if (!isAllowedHost(request.headers.get("host"), allowedHosts)) {
    return new NextResponse("Bad Request", { status: 400, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    const res = NextResponse.next();
    if (pathname.startsWith("/setup")) {
      res.headers.set("referrer-policy", "no-referrer"); // the link token is in the path
      res.headers.set("cache-control", "no-store");
    }
    return res;
  }
  if (readSessionCookie(request.headers.get("cookie"))) return NextResponse.next();

  if (isApiPath(pathname)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  const next = safeNext(pathname + search);
  url.search = next === "/" ? "?next=%2F" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url, 307);
}

// Excluded from the proxy entirely (own auth: signed URL, signature, API token, OAuth state, or session in the handler),
// plus Next's static assets. Every exclusion is on a segment boundary. NOTE: the Host check does not run on these paths;
// handlers there must call assertSameOrigin/assertAllowedHost themselves.
export const config = {
  matcher: [
    "/((?!api/uploads(?:/|$)|api/media(?:/|$)|api/webhooks(?:/|$)|api/events(?:/|$)|api/oauth(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon\\.ico$).*)",
  ],
};
