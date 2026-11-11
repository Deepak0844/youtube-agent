"use client";

import { useActionState } from "react";
import { TARGET_METRICS, TARGET_METRIC_IDS } from "@/server/core/targets";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { removeTargetAction, savePauseAction, saveTargetAction, startingTargetsAction, type TargetFormState } from "./actions";

const field = "h-10 w-full min-w-0 rounded-card border border-line bg-surface px-3 text-body";

function Msg({ s }: { s: TargetFormState }) {
  return s.error ? <p role="alert" className="text-body text-pill-negative-ink">{s.error}</p> : s.ok ? <p role="status" className="text-body text-pill-positive-ink">{s.note ?? "Saved."}</p> : null;
}

export function AddTargetForm({ channels }: { channels: Array<{ channelId: string; title: string }> }) {
  const [state, action, pending] = useActionState<TargetFormState, FormData>(saveTargetAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="t-channel">Channel</Label>
        <select id="t-channel" name="channel" className={field} defaultValue="">
          <option value="">All channels</option>
          {channels.map((c) => <option key={c.channelId} value={c.channelId}>{c.title}</option>)}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="t-metric">What to measure</Label>
        <select id="t-metric" name="metric" className={field} defaultValue="avg_view_pct">
          {TARGET_METRIC_IDS.map((m) => <option key={m} value={m}>{TARGET_METRICS[m].label} ({TARGET_METRICS[m].op === ">=" ? "at least" : "at most"})</option>)}
        </select>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="t-value">Target</Label>
        <input id="t-value" name="value" type="text" inputMode="decimal" required className={field} />
      </div>
      <Button type="submit" loading={pending}>Save target</Button>
      <Msg s={state} />
    </form>
  );
}

export function RemoveTargetForm({ id, label }: { id: number; label: string }) {
  const [state, action, pending] = useActionState<TargetFormState, FormData>(removeTargetAction, {});
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="ghost" loading={pending} aria-label={`Delete target: ${label}`}>Delete</Button>
      {state.error ? <span role="alert" className="text-small text-pill-negative-ink">{state.error}</span> : null}
    </form>
  );
}

export function StartingTargetsButton() {
  const [state, action, pending] = useActionState<TargetFormState, FormData>(() => startingTargetsAction(), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-4">
      <Button type="submit" variant="ghost" loading={pending}>Use the starting targets</Button>
      <Msg s={state} />
    </form>
  );
}

export function PauseForm({ pauseN, rpmUsd }: { pauseN: number; rpmUsd: number }) {
  const [state, action, pending] = useActionState<TargetFormState, FormData>(savePauseAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="pause_n">Pause overnight drafting after this many shorts over the cost target</Label>
        <input id="pause_n" name="pause_n" type="text" inputMode="numeric" required defaultValue={pauseN} className={field} />
        <p className="text-small text-faint">0 = off. Needs a &quot;Cost per 1,000 views&quot; target for all channels.</p>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor="rpm_usd">Revenue per 1,000 views ($, your own guess)</Label>
        <input id="rpm_usd" name="rpm_usd" type="text" inputMode="decimal" required defaultValue={rpmUsd} className={field} />
        <p className="text-small text-faint">Only used for a revenue estimate. 0 hides it.</p>
      </div>
      <Button type="submit" loading={pending}>Save</Button>
      <Msg s={state} />
    </form>
  );
}
