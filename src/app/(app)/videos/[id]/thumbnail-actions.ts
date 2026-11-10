"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { approveGate } from "@/server/db/approvals";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { requestThumbnail } from "@/server/db/thumbnail";
import { webStageQueue } from "@/server/queue/web-queues";

// Thumbnail panel (Titles tab, long videos). Same guard order as the other video page actions: requireOwner, Origin check, then the form.
// Making a card only queues the on-demand `thumbnail` stage (free, local). Approving is the thumbnail gate: session only, bound to the hash the owner saw.
export type ThumbnailState = Partial<ActionResult>;

const SEEN = /^[0-9a-f]{64}$/;

export async function makeThumbnailAction(_prev: ThumbnailState, form: FormData): Promise<ThumbnailState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const pick = form.get("assetId");
  const assetId = typeof pick === "string" && pick !== "" ? pick : null;
  const r = await requestThumbnail(getPool(), webStageQueue(), id.value, { assetId, sessionId: owner.sessionId });
  refresh();
  return r.ok ? { ok: true, message: "Queued. The thumbnail appears here in a moment." } : { ok: false, message: r.message };
}

export async function approveThumbnailAction(_prev: ThumbnailState, form: FormData): Promise<ThumbnailState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const seen = form.get("seenHash");
  if (!id.ok || typeof seen !== "string" || !SEEN.test(seen)) return { ok: false, message: BAD_FORM };
  const r = await approveGate(getPool(), { videoId: id.value, gate: "thumbnail", seenHash: seen, actor: { kind: "session", sessionId: owner.sessionId } });
  refresh();
  return r.ok ? { ok: true, message: "Thumbnail approved." } : { ok: false, message: r.reason };
}
