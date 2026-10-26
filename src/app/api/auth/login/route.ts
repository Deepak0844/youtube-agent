import { ensureAuthConfigured } from "@/lib/auth/auth-config";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { assertSameOrigin } from "@/lib/auth/origin";
import { isSecureRequest, serializeSessionCookie, trustProxy } from "@/lib/auth/session-cookie";
import { login } from "@/server/db/auth";
import { getPool } from "@/server/db/pool";

// Public JSON login (see PUBLIC_ROUTES). The token only ever travels in Set-Cookie, never in the body.
const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });

export async function POST(request: Request) {
  const bad = assertSameOrigin(request);
  if (bad) return bad;
  ensureAuthConfigured();

  let body: { username?: unknown; password?: unknown; code?: unknown };
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ error: "bad_request" }, 400);
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof body?.username !== "string" || typeof body?.password !== "string" || (body.code !== undefined && typeof body.code !== "string")) {
    return json({ error: "bad_request" }, 400);
  }

  const r = await login(getPool(), {
    username: body.username,
    password: body.password,
    code: body.code as string | undefined,
    ip: clientIpFrom(request.headers, { trustProxy: trustProxy() }),
    userAgent: request.headers.get("user-agent") ?? undefined,
  });
  if (r.ok) {
    const secure = isSecureRequest({ protocol: new URL(request.url).protocol, forwardedProto: request.headers.get("x-forwarded-proto"), trustProxy: trustProxy() });
    return json({ ok: true, expiresAt: r.expiresAt.toISOString() }, 200, { "set-cookie": serializeSessionCookie(r.token, { secure }) });
  }
  switch (r.reason) {
    case "busy":
      return json({ error: "busy" }, 503, { "retry-after": "2" });
    case "locked":
      return json({ error: "locked" }, 429, { "retry-after": String(Math.max(1, Math.ceil((r.retryAfterMs ?? 60_000) / 1000))) });
    case "vault":
      return json({ error: "vault_unavailable" }, 503);
    case "needs_totp":
      return json({ error: "totp_required" }, 401);
    default:
      return json({ error: "invalid_credentials" }, 401);
  }
}
