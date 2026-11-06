import type pg from "pg";
import { activeReview, authorRoundOf, type ReviewBody } from "@/server/core/scene3d-review";

// Where the look loop of an AI-written 3D story keeps its state: the newest `review` content, read together with the owner's Look
// send-back count and the narration it was made for. A review made before a newer send-back or another narration is history, not state.

type Q = pg.PoolClient | pg.Pool;

export async function lookSendBackCount(db: Q, videoId: string): Promise<number> {
  const r = await db.query<{ n: string }>("select count(*) as n from approvals where video_id = $1 and gate = 'look' and decision = 'sent_back'", [videoId]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function activeReviewOf(db: Q, videoId: string): Promise<ReviewBody | null> {
  const r = await db.query<{ body: unknown; narration: string | null }>(
    `select (select body from video_content where video_id = $1 and kind = 'review' order by version desc limit 1) as body,
            (select sha256 from video_content where video_id = $1 and kind = 'narration' order by version desc limit 1) as narration`,
    [videoId],
  );
  const row = r.rows[0];
  if (!row?.body) return null;
  return activeReview(row.body, await lookSendBackCount(db, videoId), row.narration);
}

/** The number the author's pipeline hash carries (revisions asked for so far). */
export async function reviewRoundOf(db: Q, videoId: string): Promise<number> {
  return authorRoundOf(await activeReviewOf(db, videoId));
}
