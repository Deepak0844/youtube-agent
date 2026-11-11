"use server";

import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { searchVideoTitles } from "@/server/db/videos-list";

// ⌘K jump-to (spec 2026-11-12 §2.3): read-only title search. Session first; the text is capped before it reaches SQL.
type VideoHit = Awaited<ReturnType<typeof searchVideoTitles>>[number];

export async function searchVideosAction(q: unknown): Promise<VideoHit[]> {
  await requireOwner();
  if (typeof q !== "string") return [];
  return searchVideoTitles(getPool(), q.slice(0, 100));
}
