import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { NOTIFY_EVENT_IDS, NOTIFY_EVENTS, defaultSwitches } from "@/server/core/notify";
import { getPool } from "@/server/db/pool";
import { recentChannelFailures } from "@/server/db/notify";
import { loadNotifyForm } from "@/server/db/notify-settings";
import { NotifyForm, type EventRow } from "./form";

const CHANNEL_NAME: Record<string, string> = { desktop: "Desktop popup", webhook: "Webhook", in_app: "Bell" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [form, failures] = await Promise.all([loadNotifyForm(db), recentChannelFailures(db)]);
  const rows: EventRow[] = NOTIFY_EVENT_IDS.map((id) => {
    const sw = { ...defaultSwitches(id), ...(form.events[id] ?? {}) };
    return { id, title: NOTIFY_EVENTS[id].title, group: NOTIFY_EVENTS[id].group, in_app: true, desktop: sw.desktop, webhook: sw.webhook };
  });
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Notifications</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Who is told, and how, when a video needs you, something goes wrong, or good news arrives. A message that cannot be delivered never stops the studio.
        </p>
      </header>
      {failures.length > 0 ? (
        <div role="alert" data-testid="delivery-banner" className="rounded-card bg-pill-negative p-pad text-body text-pill-negative-ink">
          {failures.map((f) => (
            <p key={f.channel}>
              {CHANNEL_NAME[f.channel] ?? f.channel} messages are failing ({f.count} in the last 24 hours). Check the setting below. The bell still has every message.
            </p>
          ))}
        </div>
      ) : null}
      <NotifyForm
        master={form.master}
        quiet={{ enabled: form.quietHours.enabled, start: form.quietHours.start, end: form.quietHours.end, tz: form.quietHours.tz, urgent: form.quietHours.urgent_break_through === true }}
        webhookUrl={form.webhookUrl}
        rows={rows}
      />
    </div>
  );
}
