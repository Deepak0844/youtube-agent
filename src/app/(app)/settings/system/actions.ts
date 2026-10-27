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

// Both actions are session-only (requireOwner), and the data layer can only write as a session. Next's Origin-vs-Host
// check runs before these bodies. Failures return fixed sentences, never driver text.
const TOO_LONG = "That input is too long. Nothing was saved.";

// null means missing, not text, or over the cap: an error, never an empty value that would wipe what is saved.
const text = (v: FormDataEntryValue | null, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

export async function saveLimitsAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const fields = ["concurrent_renders", "concurrent_jobs", "storage_warn_gb", "max_long_minutes"].map((k) => [k, text(form.get(k), 8)] as const);
  if (fields.some(([, v]) => v === null)) return { error: TOO_LONG };
  const r = await saveSystemSettings(getPool(), { ...Object.fromEntries(fields), scene_kit: form.get("scene_kit") === "on" });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

export async function saveLocalServicesAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const services = text(form.get("services"), 10_000);
  if (services === null) return { error: TOO_LONG };
  const r = await saveLocalServices(getPool(), services);
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error, lines: r.lines };
}
