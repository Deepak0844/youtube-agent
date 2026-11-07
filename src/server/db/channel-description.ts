import type pg from "pg";
import { channelDescriptionUrl, parseChannelDescription } from "@/server/core/channel-description";
import type { Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "./audit";
import { getAccessToken, reserveQuota, type GoogleHttp } from "./youtube-channels";

// Reads one channel's description with that channel's own token: channels.list?part=snippet&id=<channel> (1 quota unit, reserved
// first and honoured). Read only. A failure changes nothing and returns a short reason; the text is stored as untrusted data.

export type DescriptionResult = { ok: true; length: number } | { ok: false; reason: "quota" | "token" | "fetch" };

export async function refreshChannelDescription(db: pg.Pool, ring: Keyring | (() => Keyring), http: GoogleHttp, rowId: string, by: { sessionId: string | null }): Promise<DescriptionResult> {
  const { rows } = await db.query<{ channel_id: string }>("select channel_id from youtube_channels where id = $1 and status = 'connected'", [rowId]);
  const channelId = rows[0]?.channel_id;
  if (!channelId) return { ok: false, reason: "token" };
  const access = await getAccessToken(db, ring, http, rowId);
  if (!access.ok) return { ok: false, reason: "token" };
  if (!(await reserveQuota(db, "channels.list"))) return { ok: false, reason: "quota" };
  let text: string | null = null;
  try {
    const res = await http(channelDescriptionUrl(channelId), { headers: { authorization: `Bearer ${access.accessToken}` } });
    text = res.ok ? parseChannelDescription(await res.json(), channelId) : null;
  } catch {
    text = null;
  }
  if (text === null) return { ok: false, reason: "fetch" };
  await db.query("update youtube_channels set description = $2, description_fetched_at = now() where id = $1", [rowId, text]);
  await recordAudit(db, "youtube.channel_description_refreshed", { channelId, length: text.length, sessionId: by.sessionId });
  return { ok: true, length: text.length };
}
