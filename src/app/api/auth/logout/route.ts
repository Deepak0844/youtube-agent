import { assertSameOrigin } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { isSecureRequest, readSessionCookie, serializeClearCookie, trustProxy } from "@/lib/auth/session-cookie";
import { logout } from "@/server/db/auth";
import { getPool } from "@/server/db/pool";

export async function POST(request: Request) {
  const bad = assertSameOrigin(request);
  if (bad) return bad;
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;
  const token = readSessionCookie(request.headers.get("cookie"));
  if (token) await logout(getPool(), token);
  const secure = isSecureRequest({ protocol: new URL(request.url).protocol, forwardedProto: request.headers.get("x-forwarded-proto"), trustProxy: trustProxy() });
  return Response.json({ ok: true }, { headers: { "set-cookie": serializeClearCookie({ secure }), "cache-control": "no-store" } });
}
