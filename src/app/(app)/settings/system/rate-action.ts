"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveInrRate } from "@/server/db/system-settings";

export interface RateState {
  ok?: boolean;
  error?: string;
}

export async function saveInrRateAction(_prev: RateState, form: FormData): Promise<RateState> {
  await requireOwner();
  const v = form.get("inr_rate");
  const r = await saveInrRate(getPool(), typeof v === "string" && v.length <= 12 ? v : null);
  if (r.ok) revalidatePath("/", "layout");
  return r.ok ? { ok: true } : { error: r.error };
}
