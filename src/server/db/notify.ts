import type pg from "pg";
import { NOTIFY_EVENTS, decideDelivery, isNotifyEvent, localMinutes, scrubText, type NotifySettings, type NotifyEventId } from "@/server/core/notify";
import { recordAudit } from "@/server/db/audit";
import { getSetting } from "@/server/db/settings";

export interface ChannelMessage {
  title: string;
  text: string;
  message: string; // title + text, for Slack/Discord/ntfy-style webhooks
}
export interface ChannelPort {
  send(msg: ChannelMessage): Promise<void>;
}
export interface NotifyPorts {
  /** Desktop popup and webhook senders (Phase 7). A missing channel counts as a failed delivery, never as a silent success. */
  channels: Partial<Record<"desktop" | "webhook", ChannelPort>>;
  now?: () => Date;
  /** A channel that does not answer in this long counts as failed. Default 5000. */
  channelTimeoutMs?: number;
}

export interface TransitionInput {
  event: NotifyEventId;
  videoId?: string;
  from: string;
  to: string;
  /** Identifies this one transition (for example the stage run id). A redelivered job reuses it and so notifies once. */
  transitionId: string;
  /** Extra text; scrubbed of anything credential-shaped before it is stored or sent. */
  detail?: string;
}

export async function loadNotifySettings(db: pg.Pool | pg.PoolClient): Promise<NotifySettings> {
  const [master, quietHours, events] = await Promise.all([getSetting(db, "notify.master"), getSetting(db, "notify.quiet_hours"), getSetting(db, "notify.events")]);
  return { master: master as boolean, quietHours: quietHours as NotifySettings["quietHours"], events: events as NotifySettings["events"] };
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error("timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

/**
 * Fires only on a transition INTO the event's state, once per (event, video, state, transition id). The in-app row is written
 * first and is the record; other channels are best-effort and a failure never throws (it is logged and audited).
 */
export async function notifyTransition(db: pg.Pool, ports: NotifyPorts, e: TransitionInput): Promise<{ fired: boolean; notificationId?: string }> {
  if (!isNotifyEvent(e.event)) throw new RangeError("unknown notification event");
  const def = NOTIFY_EVENTS[e.event];
  if (e.to !== def.state || e.from === e.to) return { fired: false };

  const text = scrubText(e.detail ?? "");
  const title = def.title;
  const ins = await db.query<{ id: string }>(
    `insert into notifications (event, video_id, to_state, transition_id, title, text) values ($1, $2, $3, $4, $5, $6)
     on conflict do nothing returning id`,
    [e.event, e.videoId ?? null, e.to, scrubText(e.transitionId).slice(0, 200), title, text],
  );
  if (ins.rows.length === 0) return { fired: false };
  const id = ins.rows[0]!.id;

  // Everything below is best-effort: nothing here may throw into the pipeline.
  try {
    const settings = await loadNotifySettings(db);
    const now = (ports.now ?? (() => new Date()))();
    const decisions = decideDelivery(e.event, settings, localMinutes(now, settings.quietHours.tz));
    const msg: ChannelMessage = { title, text, message: text ? `${title}: ${text}` : title };
    for (const d of decisions) {
      if (d.channel === "in_app") continue;
      if (d.held) {
        await logAttempt(db, id, d.channel, "held", null);
        continue;
      }
      if (!d.deliver) continue;
      try {
        const port = ports.channels[d.channel];
        if (!port) throw new Error("channel not configured");
        await withTimeout(port.send(msg), ports.channelTimeoutMs ?? 5000);
        await logAttempt(db, id, d.channel, "sent", null);
      } catch (err) {
        const cls = err instanceof Error ? err.name : "Error"; // class only: a message can carry a URL or token
        await logAttempt(db, id, d.channel, "failed", cls);
        await recordAudit(db, "notify.delivery_failed", { event: e.event, channel: d.channel, error: cls });
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "notify.delivery_error", error: err instanceof Error ? err.name : "Error" }));
  }
  return { fired: true, notificationId: id };
}

async function logAttempt(db: pg.Pool, notificationId: string, channel: string, status: "sent" | "failed" | "held", error: string | null): Promise<void> {
  await db.query("insert into notification_log (notification_id, channel, status, error) values ($1, $2, $3, $4)", [notificationId, channel, status, error]);
}

export interface NotificationRow {
  id: string;
  at: Date;
  event: string;
  videoId: string | null;
  title: string;
  text: string;
  readAt: Date | null;
}

export async function listNotifications(db: pg.Pool, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const { rows } = await db.query(
    `select id, at, event, video_id, title, text, read_at from notifications ${opts.unreadOnly ? "where read_at is null" : ""} order by id desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({ id: r.id, at: r.at, event: r.event, videoId: r.video_id, title: r.title, text: r.text, readAt: r.read_at }));
}

export async function unreadCount(db: pg.Pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int n from notifications where read_at is null");
  return rows[0]!.n;
}

export async function markNotificationRead(db: pg.Pool, id: string): Promise<void> {
  await db.query("update notifications set read_at = now() where id = $1 and read_at is null", [id]);
}
