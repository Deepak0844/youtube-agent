import { connection } from "next/server";
import { requireOwnerApi } from "@/lib/auth/require-owner";
import { formatMetrics } from "@/server/core/health";
import { getPool } from "@/server/db/pool";
import { getSystemStatus } from "@/server/db/system-status";

// NOT public: needs a logged-in session (the proxy checks the cookie, requireOwnerApi validates it). Numbers only.
export async function GET(request: Request) {
  const owner = await requireOwnerApi(request);
  if (owner instanceof Response) return owner;
  await connection();
  const s = await getSystemStatus(getPool());
  const body = formatMetrics({ db: s.db, redis: s.redis, disk: s.disk, queue: s.queue, cpuLoad: s.cpuLoad, memory: s.memory, storageBytes: s.storageBytes });
  return new Response(body, { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" } });
}
