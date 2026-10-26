"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveLocalServices, saveSystemSettings } from "@/server/db/system-settings";

export interface FormState {
  ok?: boolean;
  error?: string;
  lines?: Array<{ line: number; reason: string }>;
}

// Both actions are session-only (requireOwner) and the data layer re-checks: the allow-list is a safety setting.
// Next's Origin-vs-Host check runs before these bodies. Failures return fixed sentences, never driver text.
const text = (v: FormDataEntryValue | null, max: number): string => (typeof v === "string" && v.length <= max ? v : "");

export async function saveLimitsAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const r = await saveSystemSettings(getPool(), {
    concurrent_renders: text(form.get("concurrent_renders"), 8),
    concurrent_jobs: text(form.get("concurrent_jobs"), 8),
    storage_warn_gb: text(form.get("storage_warn_gb"), 8),
    max_long_minutes: text(form.get("max_long_minutes"), 8),
    scene_kit: form.get("scene_kit") === "on",
  });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

export async function saveLocalServicesAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const r = await saveLocalServices(getPool(), text(form.get("services"), 10_000));
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error, lines: r.lines };
}
