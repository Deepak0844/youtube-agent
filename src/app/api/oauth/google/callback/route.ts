import { assertAllowedHost } from "@/lib/auth/origin";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { redirectUriFor } from "@/server/core/google-app";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { completeConnect, defaultGoogleHttp } from "@/server/db/youtube-channels";

// Google sends the owner back here with ?code=...&state=.... This path skips the proxy, so the host check and the real
// session check are done here. The code and state are never logged; the response carries only a short reason word.
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function GET(request: Request) {
  const bad = assertAllowedHost(request);
  if (bad) return bad;
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;

  const base = redirectUriFor(process.env.APP_URL);
  const origin = base.ok ? new URL(base.uri).origin : new URL(request.url).origin;
  const back = (q: string) => new Response(null, { status: 303, headers: { ...HEADERS, location: `${origin}/settings/channels?${q}` } });

  const p = new URL(request.url).searchParams;
  const state = p.get("state");
  const code = p.get("code");
  if (p.get("error")) return back("error=denied");
  if (!state || !code || state.length > 200 || code.length > 2000) return back("error=state");

  const r = await completeConnect(getPool(), loadKeyring, defaultGoogleHttp, { sessionId: owner.sessionId, state, code, appUrl: process.env.APP_URL });
  if (r.ok) return back("connected=1");
  return back(r.reason === "scopes" ? `error=scopes&missing=${encodeURIComponent(r.missing.join(","))}` : `error=${r.reason}`);
}
