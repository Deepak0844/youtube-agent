"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { markAllNotificationsRead } from "@/server/db/notify";

// Bell: "Mark all read". Owner session only.
export async function markAllReadAction(): Promise<void> {
  await requireOwner();
  await markAllNotificationsRead(getPool());
  revalidatePath("/", "layout");
}
