import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { AreaMenuLive } from "./nav-live";

/** The area menu with live counts (Queue: videos waiting on the owner). Reads the session, so it sits in <Suspense>. */
export async function AreaMenuWithCounts() {
  await requireOwner();
  let waiting = 0;
  try {
    const r = await getPool().query<{ n: string }>("select count(*) as n from videos where status = 'waiting'");
    waiting = Number(r.rows[0]?.n ?? 0);
  } catch {
    // a failed count only hides the badge
  }
  return <AreaMenuLive counts={{ "/queue": waiting }} />;
}
