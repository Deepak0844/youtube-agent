import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { sha256Hex } from "@/server/core/content-hash";
import { recordAudit } from "@/server/db/audit";
import { latestContent } from "@/server/db/videos";

// "Save this animation to my library": an owner decision, never automatic. There is no library table for scene code yet (the
// assets table holds image, audio and video files only), so for now this records the decision: an audit event bound to the
// SHA-256 of the accepted scene file. The button posts the hash the owner was shown; if the file changed since (a re-run made a
// new version) the approval is refused. When a library table exists, the save belongs right after this check.

// The audit row keeps the first 16 hex characters: a longer run would be blanked as a token-looking value (redactDetail).
const AUDIT_HASH_CHARS = 16;

export interface TsxLibraryState {
  /** SHA-256 of the accepted scene file, shown to the owner and posted back. */
  hash: string;
  approved: boolean;
}

const sourceOf = (body: unknown): string | null => {
  const s = (body as { source?: unknown } | null)?.source;
  return typeof s === "string" && s !== "" ? s : null;
};

export async function tsxLibraryState(db: pg.Pool, videoId: string): Promise<TsxLibraryState | null> {
  const c = await latestContent(db, videoId, "tsx");
  const src = c ? sourceOf(c.body) : null;
  if (src === null) return null;
  const hash = sha256Hex(src);
  const r = await db.query("select 1 from audit_log where event = 'tsx.library_approved' and detail->>'videoId' = $1 and detail->>'sourceSha' = $2 limit 1", [videoId, hash.slice(0, AUDIT_HASH_CHARS)]);
  return { hash, approved: (r.rowCount ?? 0) > 0 };
}

export async function approveTsxLibrarySave(db: pg.Pool, actor: GateActor, a: { videoId: string; seenHash: string }): Promise<{ ok: boolean; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const s = await tsxLibraryState(db, a.videoId);
  if (!s) return { ok: false, message: "This video has no accepted custom animation to save." };
  if (s.hash !== a.seenHash) return { ok: false, message: "The animation changed while you were looking. Reload the page and check it again." };
  if (s.approved) return { ok: true, message: "Already approved." };
  await recordAudit(db, "tsx.library_approved", { videoId: a.videoId, sourceSha: s.hash.slice(0, AUDIT_HASH_CHARS), sessionId: actor.sessionId });
  return { ok: true, message: "Approved and recorded. There is no animation library yet, so nothing was copied." };
}
