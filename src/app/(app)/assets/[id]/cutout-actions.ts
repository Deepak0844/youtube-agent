"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { queueCutout } from "@/server/db/cutout-jobs";
import { getPool } from "@/server/db/pool";

export interface CutoutState {
  ok?: boolean;
  message?: string;
}

const FIELDS = ["method", "erode", "feather", "pad", "sticker", "tolerance"] as const;

// Session first, then the Origin check, then the form. The cut-out itself is made later by the worker; this only adds a row.
export async function requestCutoutAction(_prev: CutoutState, form: FormData): Promise<CutoutState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { message: origin };
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { message: "That picture was not found." };
  const raw: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = form.get(k);
    if (typeof v === "string" && v.length <= 12) raw[k] = v;
  }
  const r = await queueCutout(getPool(), id.data, raw).catch(() => ({ ok: false as const, message: "Could not ask for the cut-out. Try again in a minute." }));
  if (!r.ok) return { message: r.message };
  refresh();
  return { ok: true };
}
