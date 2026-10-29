"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireOwner } from "@/lib/auth/require-owner";
import { RegistryError, setMediaRoute, setProviderEnabled } from "@/server/db/media-registry";
import { getPool } from "@/server/db/pool";

// Every action: requireOwner() first, zod parse, db function (session actor), one audit row inside it, then refresh().
// A RegistryError is shown as written; anything else is one generic sentence, so no SQL or stack reaches the browser.
export interface ProviderActionState {
  ok?: boolean;
  error?: string;
}

const GENERIC = "Could not save. Nothing was changed. Try again.";
const fail = (e: unknown): ProviderActionState => {
  if (e instanceof RegistryError) return { error: e.message };
  console.error(JSON.stringify({ event: "providers.action_failed", name: e instanceof Error ? e.name : "unknown" }));
  return { error: GENERIC };
};
const str = z.string().max(100);

export async function toggleProviderAction(_prev: ProviderActionState, form: FormData): Promise<ProviderActionState> {
  await requireOwner();
  const p = z.object({ provider: str, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(form));
  if (!p.success) return { error: GENERIC };
  try {
    await setProviderEnabled(getPool(), p.data.provider, p.data.enabled === "true", "session");
  } catch (e) {
    return fail(e);
  }
  refresh();
  return { ok: true };
}

export async function setRouteAction(_prev: ProviderActionState, form: FormData): Promise<ProviderActionState> {
  await requireOwner();
  const p = z.object({ provider: str, scope: str, voice: str.optional() }).safeParse(Object.fromEntries(form));
  if (!p.success) return { error: "Choose a provider and where it applies." };
  try {
    await setMediaRoute(getPool(), p.data, "session");
  } catch (e) {
    return fail(e);
  }
  refresh();
  return { ok: true };
}
