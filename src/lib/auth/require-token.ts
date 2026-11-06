import { isScope, parseBearer, type TokenScope } from "@/server/core/api-token";
import { authenticateToken, type AuthedToken } from "@/server/db/api-tokens";
import { getPool } from "@/server/db/pool";

// The ONLY door for API tokens. Import this from src/app/api/v1/** and nowhere else (a test enforces it). Sessions, pages,
// server actions, gates, settings, keys and the tokens page never look at an Authorization header. Cookies are ignored here.

const deny = (status: 401 | 403, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/** Route handlers under /api/v1: returns the token, or a 401/403 Response the handler must return as-is. */
export async function requireTokenApi(request: Request, scope: TokenScope): Promise<AuthedToken | Response> {
  const secret = parseBearer(request.headers.get("authorization"));
  if (!secret) return deny(401, "unauthorized");
  const t = await authenticateToken(getPool(), secret);
  if (!t) return deny(401, "unauthorized");
  if (!isScope(scope) || !t.scopes.includes(scope)) return deny(403, "missing_scope");
  return t;
}
