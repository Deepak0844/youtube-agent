"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { refreshChannelDescription } from "@/server/db/channel-description";
import { runIdeaResearch } from "@/server/db/idea-research";
import { createInsightsModel } from "@/server/db/insights-model";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";
import { defaultModelDeps } from "@/server/llm/default-deps";

export interface ResearchNowState {
  ok?: boolean;
  message?: string;
}

const CHANNEL = /^[A-Za-z0-9_-]{1,64}$/;

// Owner session only, Origin checked. At most one run at a time (database lock), at most $0.30 per channel. Adds proposed ideas only.
// "channel" empty = every channel that needs ideas (backlog under 5, not researched in 20 hours); a channel id = just that one.
export async function researchNowAction(form: FormData): Promise<ResearchNowState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const c = form.get("channel");
  if (typeof c !== "string" || (c !== "" && !CHANNEL.test(c))) return { ok: false, message: "Pick a channel from the list." };
  try {
    const db = getPool();
    const r = await runIdeaResearch(db, createInsightsModel(db, () => defaultModelDeps(db, loadKeyring)), { kind: "session", sessionId: owner.sessionId }, {
      channelId: c || undefined,
      refreshDescription: (id) => refreshChannelDescription(db, loadKeyring, defaultGoogleHttp, id, { sessionId: owner.sessionId }),
    });
    refresh();
    return { ok: r.added > 0, message: r.message };
  } catch {
    return { ok: false, message: "The research run failed. Nothing was added. Try again later." };
  }
}
