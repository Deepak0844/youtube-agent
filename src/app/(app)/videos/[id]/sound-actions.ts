"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { recordAudit } from "@/server/db/audit";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { latestSoundRunId, saveBedChoice } from "@/server/db/sound-tab";

// Sound tab buttons. Same guard order as the other video page actions: requireOwner, Origin check, then the form.
export type SoundState = Partial<ActionResult>;

/** Pick the music bed for this video (empty item = no owner bed). Free: the Sound step is then re-run with the existing re-run button. */
export async function chooseBedAction(_prev: SoundState, form: FormData): Promise<SoundState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const raw = form.get("item");
  if (!id.ok || typeof raw !== "string" || raw.length > 64) return { ok: false, message: BAD_FORM };
  const item = raw === "" ? null : raw;
  const db = getPool();
  if (!(await saveBedChoice(db, id.value, item))) return { ok: false, message: "That music is not in the library." };
  await recordAudit(db, "sound.bed_chosen", { videoId: id.value, sessionId: owner.sessionId, item });
  refresh();
  return { ok: true, message: item ? "Bed chosen. Re-run the Sound step to hear it." : "Bed removed. Re-run the Sound step to apply it." };
}

/** "I listened and the sound is OK" for the current Sound run. Only recorded; no gate waits on it. */
export async function earOkAction(_prev: SoundState, form: FormData): Promise<SoundState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const db = getPool();
  const run = await latestSoundRunId(db, id.value);
  if (!run) return { ok: false, message: "The Sound step has not finished yet." };
  await recordAudit(db, "sound.ear_ok", { videoId: id.value, sessionId: owner.sessionId, stageRunId: run });
  refresh();
  return { ok: true, message: "Saved." };
}
