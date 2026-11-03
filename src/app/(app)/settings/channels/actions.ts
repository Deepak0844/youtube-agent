"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { confirmChannel, defaultGoogleHttp, disconnectChannel, saveChannelSettings, startConnect } from "@/server/db/youtube-channels";

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

const whole = (v: FormDataEntryValue | null): number => (typeof v === "string" && /^[0-9]{1,3}$/.test(v) ? Number(v) : NaN);

// Owner session only (requireOwner; the data layer also demands the session actor). "Made for kids" must be an explicit yes or no.
export async function saveChannelSettingsAction(form: FormData): Promise<void> {
  const { sessionId } = await requireOwner();
  const id = uuid(form);
  const kids = form.get("madeForKids");
  const style = form.get("defaultStyle");
  const lang = form.get("language");
  if (id && (kids === "yes" || kids === "no") && typeof lang === "string" && typeof style === "string") {
    await saveChannelSettings(
      getPool(), id,
      {
        production: form.get("production") === "on", allowPublic: form.get("allowPublic") === "on", madeForKids: kids === "yes",
        synthetic: form.get("synthetic") === "on", maxUploadsPerDay: whole(form.get("maxUploadsPerDay")),
        minHoursBetweenUploads: whole(form.get("minHoursBetweenUploads")), language: lang, categoryId: whole(form.get("categoryId")),
        defaultStyle: style === "" ? null : style,
      },
      { kind: "session", sessionId },
    );
  }
  refresh();
}
