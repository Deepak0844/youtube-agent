"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { rerunStageById } from "@/server/db/video-page-actions";
import { webStageQueue } from "@/server/queue/web-queues";

// Run a failed or cancelled step again. Same guard order as /queue: requireOwner first (the session comes from it), then
// the Origin check, then the form. Cancel and the gate buttons are the /queue actions, embedded as they are.
export type RerunState = Partial<ActionResult>;

export async function rerunStageAction(_prev: RerunState, form: FormData): Promise<RerunState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const stage = z.string().max(20).safeParse(form.get("stage"));
  if (!id.ok || !stage.success) return { ok: false, message: BAD_FORM };
  const r = await rerunStageById(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, id.value, stage.data);
  refresh();
  return r;
}
