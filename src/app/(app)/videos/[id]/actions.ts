"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { requestReframe } from "@/server/db/reframe";
import { approveTsxLibrarySave } from "@/server/db/tsx-library";
import { forceRerunStageById, rerunStageById } from "@/server/db/video-page-actions";
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

// Owner "Re-run this step" for a finished free step (render, voice, sound effects, check). Same guard order.
export async function forceRerunStageAction(_prev: RerunState, form: FormData): Promise<RerunState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const stage = z.string().max(20).safeParse(form.get("stage"));
  if (!id.ok || !stage.success) return { ok: false, message: BAD_FORM };
  const r = await forceRerunStageById(getPool(), webStageQueue(), { kind: "session", sessionId: owner.sessionId }, id.value, stage.data);
  refresh();
  return r;
}

// Owner "Make 16:9 / 1:1 version" of a finished video. Free and local; final.mp4 is never changed. Same guard order.
export async function reframeAction(_prev: RerunState, form: FormData): Promise<RerunState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const format = z.string().max(10).safeParse(form.get("format"));
  if (!id.ok || !format.success) return { ok: false, message: BAD_FORM };
  const r = await requestReframe(getPool(), webStageQueue(), id.value, format.data, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "Queued. The new version appears in a minute or two." } : { ok: false, message: r.message };
}

// Owner "Save this animation to my library". Never automatic: the form posts the hash of the file the owner was shown. Same guard order.
export async function saveTsxToLibraryAction(_prev: RerunState, form: FormData): Promise<RerunState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const hash = z.string().regex(/^[0-9a-f]{64}$/).safeParse(form.get("seenHash"));
  if (!id.ok || !hash.success) return { ok: false, message: BAD_FORM };
  const r = await approveTsxLibrarySave(getPool(), { kind: "session", sessionId: owner.sessionId }, { videoId: id.value, seenHash: hash.data });
  refresh();
  return r;
}
