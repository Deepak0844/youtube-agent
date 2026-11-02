"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { requestSeo } from "@/server/db/seo";
import { webStageQueue } from "@/server/queue/web-queues";

// Titles tab button. Same guard order as the other video page actions: requireOwner, Origin check, then the form.
// It only queues the on-demand `seo` stage; the worker pays (reserve first) through the 'titles' model route.
export type SeoState = Partial<ActionResult>;

export async function writeTitlesAction(_prev: SeoState, form: FormData): Promise<SeoState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const r = await requestSeo(getPool(), webStageQueue(), id.value, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "Queued. The titles appear here in a minute or two." } : { ok: false, message: r.message };
}
