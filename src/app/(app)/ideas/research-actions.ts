"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { runIdeaResearch } from "@/server/db/idea-research";
import { createInsightsModel } from "@/server/db/insights-model";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { defaultModelDeps } from "@/server/llm/default-deps";

export interface ResearchNowState {
  ok?: boolean;
  message?: string;
}

// Owner session only, Origin checked. At most one run at a time (database lock), at most $0.30 per run. Adds proposed ideas only.
export async function researchNowAction(): Promise<ResearchNowState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  try {
    const db = getPool();
    const r = await runIdeaResearch(db, createInsightsModel(db, () => defaultModelDeps(db, loadKeyring)), { kind: "session", sessionId: owner.sessionId });
    refresh();
    return { ok: r.added > 0, message: r.message };
  } catch {
    return { ok: false, message: "The research run failed. Nothing was added. Try again later." };
  }
}
