"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { confirmChannel, defaultGoogleHttp, disconnectChannel, startConnect } from "@/server/db/youtube-channels";

const uuid = (f: FormData): string | null => {
  const v = f.get("id");
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
};

// Connect and Reconnect are the same step: a fresh consent. redirect() throws, so it stays outside any try block.
export async function connectChannelAction(): Promise<void> {
  const { sessionId } = await requireOwner();
  const r = await startConnect(getPool(), { sessionId, appUrl: process.env.APP_URL });
  redirect(r.ok ? r.url : `/settings/channels?error=${r.reason}`);
}

export async function confirmChannelAction(form: FormData): Promise<void> {
  const { sessionId } = await requireOwner();
  const id = uuid(form);
  if (id) await confirmChannel(getPool(), id, sessionId);
  refresh();
}

export async function disconnectChannelAction(form: FormData): Promise<void> {
  const { sessionId } = await requireOwner();
  const id = uuid(form);
  if (id) await disconnectChannel(getPool(), loadKeyring, defaultGoogleHttp, id, sessionId);
  refresh();
}
