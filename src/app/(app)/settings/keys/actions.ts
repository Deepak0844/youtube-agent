"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { removeProviderKey, saveProviderKey, testProviderKey } from "@/server/db/provider-keys";
import type { KeyTestResult } from "@/server/core/provider-keys";

// Server Actions: Next checks Origin against Host before these run, requireOwner() is the first statement of each, and every
// answer is a short fixed sentence. The key arrives in FormData, goes straight to the vault, and is never returned or logged.
export interface KeyActionState {
  provider?: string;
  kind?: "saved" | "removed" | "tested" | "error";
  result?: KeyTestResult;
  message?: string;
  n?: number; // changes on every answer so identical consecutive messages are still announced
}

const field = (form: FormData, name: string, max: number): string => {
  const v = form.get(name);
  return typeof v === "string" && v.length <= max ? v : "";
};
const reply = (provider: string, s: Omit<KeyActionState, "provider" | "n">): KeyActionState => ({ provider, n: Date.now(), ...s });

export async function setKeyAction(_prev: KeyActionState, form: FormData): Promise<KeyActionState> {
  await requireOwner();
  const provider = field(form, "provider", 40);
  const r = await saveProviderKey(getPool(), loadKeyring, provider, field(form, "value", 1000));
  if (!r.ok) return reply(provider, { kind: "error", message: r.message });
  refresh();
  return reply(provider, { kind: "saved", message: "Saved." });
}

export async function removeKeyAction(_prev: KeyActionState, form: FormData): Promise<KeyActionState> {
  await requireOwner();
  const provider = field(form, "provider", 40);
  const r = await removeProviderKey(getPool(), provider);
  if (!r.ok) return reply(provider, { kind: "error", message: r.message });
  refresh();
  return reply(provider, { kind: "removed", message: "Removed." });
}

export async function testKeyAction(_prev: KeyActionState, form: FormData): Promise<KeyActionState> {
  await requireOwner();
  const provider = field(form, "provider", 40);
  const r = await testProviderKey(getPool(), loadKeyring, provider);
  if (!r.ok) return reply(provider, { kind: "error", message: r.message });
  refresh();
  return reply(provider, { kind: "tested", result: r.result });
}
