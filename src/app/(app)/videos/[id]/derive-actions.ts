"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { createDerivedShort } from "@/server/db/derive";
import { getPool } from "@/server/db/pool";
import { webStageQueue } from "@/server/queue/web-queues";

// "Make a short" on the Titles tab of a long video. Same guard order as the other video page actions: requireOwner, Origin check, then the form.
// It only creates the new short and starts its free route; the owner approves its script like for any short. Nothing is paid or published here.
export type DeriveState = { ok?: boolean; message?: string; videoId?: string };

const whole = (v: FormDataEntryValue | null): number | null => (typeof v === "string" && /^[0-9]{1,4}$/.test(v.trim()) ? Number(v.trim()) : null);

export async function makeShortAction(_prev: DeriveState, form: FormData): Promise<DeriveState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  const first = whole(form.get("first"));
  const last = whole(form.get("last"));
  if (!id.ok || first === null || last === null || first < 1 || last < first) return { ok: false, message: BAD_FORM };
  const title = typeof form.get("title") === "string" ? (form.get("title") as string).trim().slice(0, 200) : "";
  const r = await createDerivedShort(getPool(), webStageQueue(), { sourceId: id.value, fromScene: first - 1, toScene: last - 1, ...(title ? { title } : {}) }, owner.sessionId);
  refresh();
  return r.ok ? { ok: true, message: "The short was started. Open it to approve its script.", videoId: r.videoId } : { ok: false, message: r.message };
}
