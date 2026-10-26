import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPool } from "@/server/db/pool";
import { validateSession } from "@/server/db/auth";
import { readSessionCookie, SESSION_COOKIE } from "./session-cookie";

// The REAL session check (the proxy only looks for the cookie). The token is read from the cookie only, never from a
// query string or body. Under cacheComponents, call this from inside a <Suspense> boundary (cookies() is request-time data).

/** Pages, server components, server actions: no/invalid session -> redirect('/login') (throws). */
export async function requireOwner(): Promise<{ sessionId: string }> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const s = await validateSession(getPool(), token);
  if (!s.ok) redirect("/login");
  return { sessionId: s.sessionId };
}

const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401, headers: { "cache-control": "no-store" } });

/** Route handlers: returns the session, or a 401 Response the handler must return as-is. */
export async function requireOwnerApi(request: Request): Promise<{ sessionId: string } | Response> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return unauthorized();
  const s = await validateSession(getPool(), token);
  return s.ok ? { sessionId: s.sessionId } : unauthorized();
}
