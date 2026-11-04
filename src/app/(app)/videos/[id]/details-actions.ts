"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";
import { saveUploadDetails } from "@/server/db/upload-details";

// Upload details form on the Titles tab. Guard order as the other video page actions: requireOwner, Origin check, then the form.
export type DetailsState = Partial<ActionResult>;

const text = (f: FormData, k: string): string => (typeof f.get(k) === "string" ? (f.get(k) as string) : "");
// made for kids is an explicit radio: anything but "yes" or "no" is left undefined so the server refuses it.
const choice = (f: FormData, k: string): boolean | undefined => (text(f, k) === "yes" ? true : text(f, k) === "no" ? false : undefined);

export async function saveDetailsAction(_prev: DetailsState, form: FormData): Promise<DetailsState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const r = await saveUploadDetails(getPool(), id.value, {
    title: text(form, "title"),
    description: text(form, "description"),
    tags: text(form, "tags").split(","),
    category_id: Number(text(form, "category_id")),
    language: text(form, "language").trim(),
    made_for_kids: choice(form, "made_for_kids"),
    synthetic_content: choice(form, "synthetic_content"),
  }, { kind: "session", sessionId: owner.sessionId });
  refresh();
  return r.ok ? { ok: true, message: "Saved. A publish approval you gave earlier no longer counts: approve again." } : { ok: false, message: r.message };
}
