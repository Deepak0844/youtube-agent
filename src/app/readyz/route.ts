import { connection } from "next/server";
import { getPool } from "@/server/db/pool";

// Public. Reveals only up/down. connection() keeps it out of prerendering (cacheComponents) so it asks the DB per request.
export async function GET() {
  await connection();
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
