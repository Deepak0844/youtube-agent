import type pg from "pg";
import type { NotifyPorts } from "@/server/db/notify";
import { getWebhookUrl } from "@/server/db/notify-settings";
import { createDesktopPort, createWebhookPort } from "./senders";

/** The real channels for the worker. The webhook address is read fresh on every call, so a change on the settings page applies to the next message. */
export async function realNotifyPorts(db: pg.Pool): Promise<NotifyPorts> {
  let url = "";
  try { url = await getWebhookUrl(db); } catch { /* no address: the webhook channel counts as failed if it is switched on */ }
  // No real popups from automated tests.
  return { channels: { ...(process.env.NODE_ENV === "test" ? {} : { desktop: createDesktopPort() }),...(url ? { webhook: createWebhookPort(url) } : {}) } };
}
