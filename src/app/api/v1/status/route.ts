import { assertAllowedHost } from "@/lib/auth/origin";
import { requireTokenApi } from "@/lib/auth/require-token";
import { statusCounts } from "@/server/db/api-tokens";
import { getPool } from "@/server/db/pool";

// Read-only: counts of videos by status. Scope: read.
export async function GET(request: Request) {
  const hostErr = assertAllowedHost(request);
  if (hostErr) return hostErr;
  const t = await requireTokenApi(request, "read");
  if (t instanceof Response) return t;
  return Response.json({ videos: await statusCounts(getPool()) }, { headers: { "cache-control": "no-store" } });
}
