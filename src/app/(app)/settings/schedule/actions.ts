"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveSchedulerSettings } from "@/server/db/system-settings";

export interface ScheduleFormState {
  ok?: boolean;
  error?: string;
}

const flag = (f: FormData, k: string): boolean => f.get(k) === "on";
const whole = (f: FormData, k: string): number => {
  const v = f.get(k);
  return typeof v === "string" && /^\d{1,2}$/.test(v) ? Number(v) : Number.NaN;
};

// requireOwner first, then the same-origin check, then the form. Tracks are fixed (tsx) and not read from the form.
export async function saveScheduleAction(_prev: ScheduleFormState, form: FormData): Promise<ScheduleFormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const r = await saveSchedulerSettings(
    getPool(),
    {
      enabled: flag(form, "enabled"),
      hour: whole(form, "hour"),
      max_drafts: whole(form, "max_drafts"),
      research: flag(form, "research"),
      max_pending: whole(form, "max_pending"),
      tracks: ["tsx"],
      analytics: flag(form, "analytics"),
      weekly_review: flag(form, "weekly_review"),
      weekly_day: whole(form, "weekly_day"),
      weekly_hour: whole(form, "weekly_hour"),
      optimizer: flag(form, "optimizer"),
      optimizer_hour: whole(form, "optimizer_hour"),
      competitors: flag(form, "competitors"),
    },
    flag(form, "confirm_spend"),
  );
  if (r.ok) refresh();
  return r.ok ? { ok: true } : { error: r.error };
}
