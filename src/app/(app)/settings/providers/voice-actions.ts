"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveVoiceServer } from "@/server/db/system-settings";

export interface VoiceFormState {
  ok?: boolean;
  error?: string;
}

// Session-only (requireOwner); the data layer can only write as a session. Next checks Origin against Host before this runs.
// The rules are the voice stage's own (see endpoints.ts). Failures are fixed sentences or a short quote of the typed text.
export async function saveVoiceServerAction(_prev: VoiceFormState, form: FormData): Promise<VoiceFormState> {
  await requireOwner();
  const value = form.get("value");
  if (typeof value !== "string" || value.length > 400) return { error: "That input is too long. Nothing was saved." };
  const r = await saveVoiceServer(getPool(), form.get("field"), value);
  if (r.ok) revalidatePath("/settings/providers");
  return r.ok ? { ok: true } : { error: r.error };
}
