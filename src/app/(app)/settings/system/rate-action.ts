"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { refreshInrRate, safeFxFetcher } from "@/server/db/fx-rate";
import { saveInrAuto, saveInrRate } from "@/server/db/system-settings";

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

// Owner session only: the daily automatic update on or off (one click either way).
export async function saveInrAutoAction(_prev: RateState, form: FormData): Promise<RateState> {
  await requireOwner();
  const r = await saveInrAuto(getPool(), form.get("auto") === "on");
  if (r.ok) revalidatePath("/", "layout");
  return r.ok ? { ok: true } : { error: r.error };
}

// Owner session only: fetch today's rate now from the free rate service (nothing is sent but the request for the rate).
export async function updateInrRateNowAction(): Promise<RateState> {
  await requireOwner();
  const r = await refreshInrRate(getPool(), safeFxFetcher);
  if (r.ok) revalidatePath("/", "layout");
  return r.ok ? { ok: true } : { error: r.error };
}
