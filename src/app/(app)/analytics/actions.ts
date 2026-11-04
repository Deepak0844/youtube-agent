"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { pullAnalytics, pullMessage } from "@/server/db/analytics";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";

export interface PullState {
  ok?: boolean;
  message?: string;
}

// Owner session only. Reads from YouTube and writes snapshots; it never uploads, posts or changes anything on YouTube.
export async function pullAnalyticsAction(): Promise<PullState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  try {
    const r = await pullAnalytics(getPool(), loadKeyring, defaultGoogleHttp, { kind: "session", sessionId: owner.sessionId });
    refresh();
    return { ok: r.failed === 0 && !r.quotaStopped, message: pullMessage(r) };
  } catch {
    return { ok: false, message: "The pull could not finish. Nothing was changed on YouTube. Try again." };
  }
}
