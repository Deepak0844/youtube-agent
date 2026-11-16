"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { createClipShorts } from "@/server/db/clip-shorts";
import { requestClips } from "@/server/db/clips";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { webStageQueue } from "@/server/queue/web-queues";
import { storageRoot } from "@/server/storage/paths";

// Clips tab buttons. Same guard order as the other video page actions: requireOwner (a signed-in session), the Origin check, then the form.
// "Cut clips" only queues the free, local `clips` stage. "Make Shorts" turns the chosen clips into Shorts that wait at the normal gates: it approves,
// verifies and publishes nothing.
export type ClipsState = Partial<ActionResult>;

export async function cutClipsAction(_prev: ClipsState, form: FormData): Promise<ClipsState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const r = await requestClips(getPool(), webStageQueue(), id.value, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "Queued. The clips appear here in a few minutes." } : { ok: false, message: r.message };
}

export async function makeClipShortsAction(_prev: ClipsState, form: FormData): Promise<ClipsState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const batch = Number(form.get("batch"));
  const clipIds = form.getAll("clipId").filter((v): v is string => typeof v === "string" && /^c\d{1,3}$/.test(v));
  if (!id.ok || !Number.isInteger(batch) || batch < 1) return { ok: false, message: BAD_FORM };
  const r = await createClipShorts(getPool(), webStageQueue(), { root: storageRoot(), sourceVideoId: id.value, batch, clipIds, sessionId: owner.sessionId });
  refresh();
  if (!r.ok) return { ok: false, message: r.message };
  const made = r.created.length;
  const skipped = r.skipped.map((s) => s.reason);
  if (made === 0) return { ok: false, message: skipped[0] ?? "No Short was made." };
  return { ok: true, message: `${made} Short${made === 1 ? "" : "s"} made. Open each one to approve its script.${skipped.length > 0 ? ` Skipped: ${skipped.join(" ")}` : ""}` };
}
