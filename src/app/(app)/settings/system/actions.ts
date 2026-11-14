"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { ENGINE_NUMBER_FIELDS } from "@/server/core/engine-numbers";
import { hostPortOf, isVoiceField } from "@/server/providers/voice/endpoints";
import { loadLocalServices, loadVoiceServers, saveEngineNumbers, saveEngineSwitch, saveLocalServices, saveSystemSettings, saveUploadSwitches } from "@/server/db/system-settings";

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
  const fields = ["concurrent_renders", "concurrent_jobs", "storage_warn_gb", "max_long_minutes", "render_timeout_s"].map((k) => [k, text(form.get(k), 8)] as const);
  if (fields.some(([, v]) => v === null)) return { error: TOO_LONG };
  const r = await saveSystemSettings(getPool(), { ...Object.fromEntries(fields) });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

// Owner session only. Two separate forms: the kill switch (one click either way) and the go-live cutover (typed phrase to turn ON).
export async function saveKillSwitchAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const r = await saveUploadSwitches(getPool(), { killSwitch: form.get("kill") === "on" });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

// Owner session only. The new video engine (Claude Code with tools) for Custom animation videos: one click either way.
export async function saveEngineSwitchAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const r = await saveEngineSwitch(getPool(), form.get("engine") === "on");
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

export async function saveCutoverAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const on = form.get("cutover") === "on";
  const typed = text(form.get("typed"), 40);
  if (typed === null) return { error: TOO_LONG };
  const r = await saveUploadSwitches(getPool(), { cutover: on, typed });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}

export async function saveLocalServicesAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const services = text(form.get("services"), 10_000);
  if (services === null) return { error: TOO_LONG };
  const r = await saveLocalServices(getPool(), services, { confirmed: form.get("confirm") === "on" });
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error, lines: r.lines };
}

// One-click helper next to a voice address: adds that address's host:port (read from the SAVED setting, never from the
// browser) to the list. Same rules, confirmation and audit as the editor above.
export async function addVoiceServiceAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const field = form.get("field");
  if (!isVoiceField(field) || field === "azure_region") return { error: "Nothing was saved." };
  const db = getPool();
  const entry = hostPortOf((await loadVoiceServers(db))[field]);
  if (!entry) return { error: "Save a valid address first." };
  const current = await loadLocalServices(db);
  if (current.includes(entry)) return { ok: true };
  const r = await saveLocalServices(db, [...current, entry].join("\n"), { confirmed: form.get("confirm") === "on" });
  if (r.ok) {
    revalidatePath("/settings/system");
    revalidatePath("/settings/providers");
  }
  return r.ok ? { ok: true } : { error: r.error, lines: r.lines };
}

// Engine numbers (retries, time limits, breaker, QA). Reset-to-default is done in the form (it refills the field); this saves what was sent.
export async function saveEngineNumbersAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const input: Record<string, unknown> = {};
  for (const f of ENGINE_NUMBER_FIELDS) {
    const v = text(form.get(f.key), 200);
    if (v === null) return { error: TOO_LONG };
    input[f.key] = v;
  }
  const r = await saveEngineNumbers(getPool(), input);
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true } : { error: r.error };
}
