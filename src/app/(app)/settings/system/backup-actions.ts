"use server";

import { revalidatePath } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { runBackup } from "@/server/db/backup";
import { getPool } from "@/server/db/pool";

// Owner session only (requireOwner), audited inside runBackup. The page reads the stored result; nothing is returned to the browser.
export async function backUpNowAction(): Promise<void> {
  const owner = await requireOwner();
  if (await assertActionOrigin()) return;
  await runBackup(getPool(), owner.sessionId);
  revalidatePath("/settings/system");
}
