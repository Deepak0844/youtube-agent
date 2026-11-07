"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { removeTarget, saveTarget, applyStartingTargets } from "@/server/db/targets";
import { saveTargetSettings } from "@/server/db/system-settings";

export interface TargetFormState {
  ok?: boolean;
  error?: string;
  note?: string;
}

// Every action: requireOwner first, then the same-origin check, then the form.
const text = (f: FormData, k: string, max: number): string | null => {
  const v = f.get(k);
  return typeof v === "string" && v.length <= max ? v : null;
};

export async function saveTargetAction(_prev: TargetFormState, form: FormData): Promise<TargetFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const r = await saveTarget(getPool(), { channelId: text(form, "channel", 64), metric: text(form, "metric", 40), value: text(form, "value", 20) }, owner.sessionId);
  if (r.ok) refresh();
  return r.ok ? { ok: true } : { error: r.error };
}

export async function removeTargetAction(_prev: TargetFormState, form: FormData): Promise<TargetFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const r = await removeTarget(getPool(), text(form, "id", 20), owner.sessionId);
  if (r.ok) refresh();
  return r.ok ? { ok: true } : { error: r.error };
}

export async function startingTargetsAction(): Promise<TargetFormState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const { made } = await applyStartingTargets(getPool(), owner.sessionId);
  refresh();
  return { ok: true, note: made.length ? `Added ${made.length} starting target${made.length === 1 ? "" : "s"}.` : "You already have all the starting targets." };
}

export async function savePauseAction(_prev: TargetFormState, form: FormData): Promise<TargetFormState> {
  await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const r = await saveTargetSettings(getPool(), { pauseN: text(form, "pause_n", 4), rpmUsd: text(form, "rpm_usd", 12) });
  if (r.ok) refresh();
  return r.ok ? { ok: true } : { error: r.error };
}
