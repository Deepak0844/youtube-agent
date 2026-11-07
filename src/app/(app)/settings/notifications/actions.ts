"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { CHANNELS, NOTIFY_EVENT_IDS } from "@/server/core/notify";
import { checkWebhookUrl } from "@/server/core/notify-send";
import { getPool } from "@/server/db/pool";
import { getWebhookUrl, saveNotifyForm } from "@/server/db/notify-settings";
import { createWebhookPort } from "@/server/providers/notify/senders";

export interface FormState {
  ok?: boolean;
  error?: string;
  message?: string;
}

const text = (v: FormDataEntryValue | null, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

export async function saveNotifyAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const start = text(form.get("quiet_start"), 5);
  const end = text(form.get("quiet_end"), 5);
  const tz = text(form.get("quiet_tz"), 60);
  const url = text(form.get("webhook_url"), 2000);
  if (start === null || end === null || tz === null || url === null) return { error: "That input is too long. Nothing was saved." };
  const events = Object.fromEntries(NOTIFY_EVENT_IDS.map((id) => [id, Object.fromEntries(CHANNELS.map((c) => [c, form.get(`ev.${id}.${c}`) === "on"]))]));
  const r = await saveNotifyForm(getPool(), {
    master: form.get("master") === "on",
    quietHours: { enabled: form.get("quiet_enabled") === "on", start, end, tz, urgent_break_through: form.get("quiet_urgent") === "on" },
    events,
    webhookUrl: url,
  });
  if (!r.ok) return { error: r.error };
  revalidatePath("/settings/notifications");
  return { ok: true };
}

// Session-only. Sends one sample message to the address typed in the form (or the saved one when the field is empty); saves nothing.
// Private and loopback addresses are refused by the same sender the worker uses. Answers are fixed sentences, never driver or URL text.
export async function testWebhookAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const typed = text(form.get("webhook_url"), 2000);
  if (typed === null) return { error: "That input is too long." };
  const url = typed.trim() || await getWebhookUrl(getPool());
  if (!url) return { error: "Enter a webhook address first." };
  const bad = checkWebhookUrl(url);
  if (bad) return { error: bad };
  try {
    await createWebhookPort(url).send({ title: "YT Studio test", text: "This is a test message.", message: "YT Studio test: This is a test message." });
    return { ok: true, message: "Test message sent." };
  } catch {
    return { error: "The test message did not go through. The address may be private, wrong or down." };
  }
}
