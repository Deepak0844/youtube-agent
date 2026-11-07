import type pg from "pg";
import { checkWebhookUrl } from "@/server/core/notify-send";
import { NOTIFY_EVENT_IDS, CHANNELS, type NotifySettings } from "@/server/core/notify";
import { recordAudit } from "@/server/db/audit";
import { getSetting, setSessionSettings } from "@/server/db/settings";

// Writer behind /settings/notifications. The caller has done requireOwner(). Everything goes through setSessionSettings (one
// transaction, session-only because the webhook address is a safety key). The audit row never holds the webhook address
// (it can carry a token): only its host.
export interface NotifyForm extends NotifySettings {
  webhookUrl: string;
}

export async function loadNotifyForm(db: pg.Pool): Promise<NotifyForm> {
  const [master, quietHours, events, webhookUrl] = await Promise.all(["notify.master", "notify.quiet_hours", "notify.events", "notify.webhook_url"].map((k) => getSetting(db, k)));
  return { master: master as boolean, quietHours: quietHours as NotifyForm["quietHours"], events: events as NotifyForm["events"], webhookUrl: webhookUrl as string };
}

const hostOf = (u: unknown): string => {
  try { return typeof u === "string" && u ? new URL(u).host : ""; } catch { return ""; }
};

export async function getWebhookUrl(db: pg.Pool): Promise<string> {
  return String(await getSetting(db, "notify.webhook_url"));
}

export type SaveNotifyResult = { ok: true } | { ok: false; error: string };

export async function saveNotifyForm(db: pg.Pool, f: NotifyForm): Promise<SaveNotifyResult> {
  const url = f.webhookUrl.trim();
  if (url) {
    const bad = checkWebhookUrl(url);
    if (bad) return { ok: false, error: bad };
  }
  const events = Object.fromEntries(NOTIFY_EVENT_IDS.map((id) => [id, Object.fromEntries(CHANNELS.map((c) => [c, f.events[id]?.[c] === true]))]));
  try {
    await setSessionSettings(
      db,
      [
        { key: "notify.master", value: f.master },
        { key: "notify.quiet_hours", value: f.quietHours },
        { key: "notify.events", value: events },
        { key: "notify.webhook_url", value: url },
      ],
      async (client, key, c) => {
        if (JSON.stringify(c.old) === JSON.stringify(c.new)) return;
        const url = key === "notify.webhook_url";
        await recordAudit(client, "setting.changed", { setting: key, from: url ? hostOf(c.old) : c.old, to: url ? hostOf(c.new) : c.new });
      },
    );
    return { ok: true };
  } catch {
    return { ok: false, error: "That could not be saved. Check the times, the time zone and the address." };
  }
}
