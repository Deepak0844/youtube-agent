"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { saveUploadSwitches } from "@/server/db/system-settings";

export interface PublicState {
  ok?: boolean;
  error?: string;
}

// Owner session only. Allowing public publishing needs the typed phrase; turning it off is one click. The evidence rule has no writer anywhere.
export async function savePublicSwitchAction(_prev: PublicState, form: FormData): Promise<PublicState> {
  await requireOwner();
  const typed = form.get("typed");
  if (typeof typed !== "string" || typed.length > 40) return { error: "That input is too long. Nothing was saved." };
  const r = await saveUploadSwitches(getPool(), { allowPublic: form.get("allowPublic") === "on", typedPublic: typed });
  if (r.ok) revalidatePath("/settings/policies");
  return r.ok ? { ok: true } : { error: r.error };
}
