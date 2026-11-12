"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { markAllNotificationsRead, markNotificationRead } from "@/server/db/notify";

// Bell: "Mark all read". Owner session only.
export async function markAllReadAction(): Promise<void> {
  await requireOwner();
  await markAllNotificationsRead(getPool());
  revalidatePath("/", "layout");
}

// Bell: "Mark as read" on one message. Owner session only; the id is a positive integer (bigserial) or nothing happens.
export async function markOneReadAction(form: FormData): Promise<void> {
  await requireOwner();
  const id = form.get("id");
  if (typeof id !== "string" || !/^[1-9][0-9]{0,18}$/.test(id)) return;
  await markNotificationRead(getPool(), id);
  revalidatePath("/", "layout");
}
