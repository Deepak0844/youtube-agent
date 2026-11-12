"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveNotifyAction, testWebhookAction, type FormState } from "./actions";

export interface EventRow {
  id: string;
  title: string;
  group: string;
  in_app: boolean;
  desktop: boolean;
  webhook: boolean;
}

const GROUPS: Array<[string, string]> = [
  ["needs_you", "Needs you"],
  ["problems", "Problems"],
  ["good_news", "Good news"],
];
const box = "size-5 accent-[var(--color-text,currentColor)]";

export function NotifyForm(props: {
  master: boolean;
  quiet: { enabled: boolean; start: string; end: string; tz: string; urgent: boolean };
  webhookUrl: string;
  rows: EventRow[];
}) {
  const [state, save, saving] = useActionState<FormState, FormData>(saveNotifyAction, {});
  // Controlled: React resets uncontrolled fields after every form action, which would blank the address the owner just typed.
  const [url, setUrl] = useState(props.webhookUrl);
  const [test, runTest, testing] = useActionState<FormState, FormData>(testWebhookAction, {});
  return (
    <form action={save} className="grid min-w-0 gap-layout xl:col-span-2 xl:grid-cols-2 xl:items-start">
      <section aria-labelledby="master-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="master-h" className="text-title font-semibold">Master switch</h2>
        <label className="mt-3 flex items-center gap-3 text-body">
          <input type="checkbox" name="master" defaultChecked={props.master} className={box} />
          Send desktop and webhook messages
        </label>
        <p className="mt-1 text-small text-muted">The bell in the top bar always keeps the record, even when this is off.</p>
      </section>

      <section aria-labelledby="quiet-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="quiet-h" className="text-title font-semibold">Quiet hours</h2>
        <p className="mt-1 text-small text-muted">During quiet hours desktop and webhook messages are held, not sent. The bell still fills.</p>
        <label className="mt-3 flex items-center gap-3 text-body">
          <input type="checkbox" name="quiet_enabled" defaultChecked={props.quiet.enabled} className={box} />
          Hold messages during quiet hours
        </label>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="quiet_start">From</Label>
            <Input id="quiet_start" name="quiet_start" type="time" required defaultValue={props.quiet.start} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="quiet_end">Until</Label>
            <Input id="quiet_end" name="quiet_end" type="time" required defaultValue={props.quiet.end} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="quiet_tz">Time zone</Label>
            <Input id="quiet_tz" name="quiet_tz" required defaultValue={props.quiet.tz} />
          </div>
        </div>
        <label className="mt-3 flex items-center gap-3 text-body">
          <input type="checkbox" name="quiet_urgent" defaultChecked={props.quiet.urgent} className={box} />
          Urgent messages (paid call may have run, spend cap hit) break through
        </label>
      </section>

      <section aria-labelledby="hook-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="hook-h" className="text-title font-semibold">Webhook</h2>
        <p className="mt-1 text-small text-muted">
          Posts JSON with title, text and message (works with Slack, Discord and ntfy style hooks). Public addresses only. Leave empty for none.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <Label htmlFor="webhook_url">Webhook address</Label>
          <Input id="webhook_url" name="webhook_url" type="url" inputMode="url" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" formAction={runTest} disabled={testing}>Send test message</Button>
          <p role="status" className={test.error ? "text-body text-pill-negative-ink" : "text-body text-pill-positive-ink"} data-testid="webhook-test-result">
            {test.error ?? test.message ?? ""}
          </p>
        </div>
      </section>

      {GROUPS.map(([g, label]) => (
        <section key={g} aria-labelledby={`g-${g}`} className="rounded-card border border-border bg-surface p-pad">
          <h2 id={`g-${g}`} className="text-title font-semibold">{label}</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-body">
              <thead>
                <tr className="text-left text-small text-muted">
                  <th scope="col" className="pr-4 pb-2 font-medium">Event</th>
                  <th scope="col" className="px-2 pb-2 font-medium">Bell</th>
                  <th scope="col" className="px-2 pb-2 font-medium">Popup</th>
                  <th scope="col" className="px-2 pb-2 font-medium">Webhook</th>
                </tr>
              </thead>
              <tbody>
                {props.rows.filter((r) => r.group === g).map((r) => (
                  <tr key={r.id}>
                    <th scope="row" className="py-1 pr-4 text-left font-normal">{r.title}</th>
                    {(["in_app", "desktop", "webhook"] as const).map((c) => (
                      <td key={c} className="px-2 py-1">
                        <input
                          type="checkbox"
                          name={`ev.${r.id}.${c}`}
                          defaultChecked={c === "in_app" ? true : r[c]}
                          disabled={c === "in_app"}
                          aria-label={`${r.title}: ${c === "in_app" ? "bell" : c === "desktop" ? "popup" : "webhook"}`}
                          className={box}
                        />
                        {c === "in_app" ? <input type="hidden" name={`ev.${r.id}.in_app`} value="on" /> : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3 xl:col-span-2">
        <Button type="submit" loading={saving}>Save</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : <p role="status" className="sr-only" />}
      </div>
    </form>
  );
}
