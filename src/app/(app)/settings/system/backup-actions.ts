"use server";

import { revalidatePath } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { runBackup, saveBackupExtraDir } from "@/server/db/backup";
import { getPool } from "@/server/db/pool";

// Owner session only (requireOwner), audited inside runBackup. The page reads the stored result; nothing is returned to the browser.
export async function backUpNowAction(): Promise<void> {
  const owner = await requireOwner();
  if (await assertActionOrigin()) return;
  await runBackup(getPool(), owner.sessionId);
  revalidatePath("/settings/system");
}

// The optional extra copy folder. Session only, Origin checked, then the form. The path is checked before it is saved (see saveBackupExtraDir).
export type ExtraDirState = { ok?: boolean; message?: string };

export async function saveExtraDirAction(_prev: ExtraDirState, form: FormData): Promise<ExtraDirState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const raw = form.get("dir");
  if (typeof raw !== "string" || raw.length > 400) return { ok: false, message: "That folder name is not usable." };
  const r = await saveBackupExtraDir(getPool(), owner.sessionId, raw);
  if (r.ok) revalidatePath("/settings/system");
  return r.ok ? { ok: true, message: r.on ? "Saved. Every backup is now also copied there." : "Saved. Backups are no longer copied anywhere else." } : { ok: false, message: r.error };
}
