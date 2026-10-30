"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveAssetSettings } from "@/server/db/system-settings";

export interface FormState {
  ok?: boolean;
  error?: string;
}

const FIELDS = ["retention_days", "unused_days", "trash_days", "max_image_mb", "max_audio_mb", "max_megapixels", "max_batch_files", "total_gb"];

// Session-only (requireOwner); the data layer can only write as a session. Failures return fixed sentences.
export async function saveAssetSettingsAction(_prev: FormState, form: FormData): Promise<FormState> {
  await requireOwner();
  const fields = FIELDS.map((k) => {
    const v = form.get(k);
    return [k, typeof v === "string" && v.length <= 8 ? v : null] as const;
  });
  if (fields.some(([, v]) => v === null)) return { error: "That input is too long. Nothing was saved." };
  const r = await saveAssetSettings(getPool(), Object.fromEntries(fields));
  if (r.ok) {
    revalidatePath("/settings/assets");
    revalidatePath("/assets");
  }
  return r.ok ? { ok: true } : { error: r.error };
}
