import type pg from "pg";
import type { GateId } from "@/server/core/gates";
import { IMPLEMENTED_GATES } from "@/server/core/approvals";
import { approvalState } from "@/server/db/approvals";
import type { PipelineReaders } from "@/server/db/pipeline";

// The real answer to "what has the owner decided?" for the pipeline. Approvals are derived on every read (db/approvals.ts):
// a gate counts only while its newest decision is 'approved' AND its hash equals the live hash. The same readers go to
// advance, retry scheduling, the retry sweep and the queue page, so they can never disagree.
export const approvalReaders: PipelineReaders = {
  async approvedGates(db: pg.PoolClient, videoId: string): Promise<ReadonlySet<GateId>> {
    const out = new Set<GateId>();
    for (const g of IMPLEMENTED_GATES) if ((await approvalState(db, videoId, g)).approved) out.add(g);
    return out;
  },
  /** The note on the newest script send-back, or null. A newer send-back replaces it; it changes the draft's input hash, so the draft reruns once. */
  async feedback(db: pg.PoolClient, videoId: string): Promise<string | null> {
    const r = await db.query<{ note: string | null }>(
      "select note from approvals where video_id = $1 and gate = 'script' and decision = 'sent_back' order by seq desc limit 1",
      [videoId],
    );
    return r.rows[0]?.note ?? null;
  },
};
