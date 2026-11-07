"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { refreshChannelDescription } from "@/server/db/channel-description";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import { defaultGoogleHttp } from "@/server/db/youtube-channels";

export interface RefreshDescriptionState {
  ok?: boolean;
  message?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WHY = { quota: "Not enough YouTube quota left today. Try tomorrow.", token: "This channel's Google login is not usable. Reconnect it.", fetch: "YouTube did not return the description. Try again later." } as const;

// Owner session only, Origin checked. One read-only YouTube call (1 quota unit) with this channel's own token.
export async function refreshDescriptionAction(_prev: RefreshDescriptionState, form: FormData): Promise<RefreshDescriptionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = form.get("id");
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, message: "That channel was not found." };
  try {
    const r = await refreshChannelDescription(getPool(), loadKeyring, defaultGoogleHttp, id, { sessionId: owner.sessionId });
    refresh();
    return r.ok ? { ok: true, message: r.length ? `Description saved (${r.length} characters).` : "The channel has no description on YouTube." } : { ok: false, message: WHY[r.reason] };
  } catch {
    return { ok: false, message: WHY.fetch };
  }
}
