"use client";

import { useActionState, useState } from "react";
import type { SchedulerSettings } from "@/server/core/scheduler";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { saveScheduleAction, type ScheduleFormState } from "./actions";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const box = "h-5 w-5 shrink-0 accent-[var(--color-accent,currentColor)]";
const field = "h-10 w-full min-w-0 rounded-card border border-line bg-surface px-3 text-body";

function Check({ name, label, note, defaultChecked }: { name: string; label: string; note: string; defaultChecked: boolean }) {
  return (
    <label className="flex min-w-0 items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className={`${box} mt-0.5`} />
      <span className="min-w-0">
        <span className="block text-body font-medium">{label}</span>
        <span className="block text-small text-muted">{note}</span>
      </span>
    </label>
  );
}

function Num({ name, label, note, value, min, max }: { name: string; label: string; note: string; value: number; min: number; max: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={name}>{label}</Label>
      <input id={name} name={name} type="number" inputMode="numeric" min={min} max={max} step={1} required defaultValue={value} className={field} />
      <p className="text-small text-faint">{note}</p>
    </div>
  );
}

export function ScheduleForm({ s }: { s: SchedulerSettings }) {
  const [state, action, pending] = useActionState<ScheduleFormState, FormData>(saveScheduleAction, {});
  const [on, setOn] = useState(s.enabled);
  return (
    <form action={action} className="flex flex-col gap-layout">
      <section aria-labelledby="draft-h" className="flex flex-col gap-4 rounded-card bg-surface p-pad">
        <h2 id="draft-h" className="text-title font-semibold">Overnight drafting</h2>
        <p className="max-w-[60ch] text-body text-muted">
          Drafts videos while you sleep and stops at your first approval step. It never approves anything and never uploads. Paid steps still obey your spending limits.
          At the start hour it takes the best ideas from your backlog, one at a time, up to the limits below.
        </p>
        <label className="flex min-w-0 items-start gap-3">
          <input type="checkbox" name="enabled" checked={on} onChange={(e) => setOn(e.target.checked)} className={`${box} mt-0.5`} />
          <span className="min-w-0">
            <span className="block text-body font-medium">Draft videos overnight</span>
            <span className="block text-small text-muted">Off until you turn it on.</span>
          </span>
        </label>
        <label className="flex min-w-0 items-start gap-3" hidden={!on}>
          <input type="checkbox" name="confirm_spend" className={`${box} mt-0.5`} />
          <span className="text-body">I understand overnight drafting spends money (up to my limits) while I am away.</span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Num name="hour" label="Start hour (IST)" note="A 3 hour window starts then. 0 to 23." value={s.hour} min={0} max={23} />
          <Num name="max_drafts" label="Drafts per night" note="0 to 5." value={s.max_drafts} min={0} max={5} />
          <Num name="max_pending" label="Most drafts waiting for you" note="Drafting pauses when this many wait. 1 to 10." value={s.max_pending} min={1} max={10} />
        </div>
        <p className="text-small text-muted">Video kind: code-scene (tsx) only. Other kinds arrive in a later phase.</p>
        <Check name="research" label="Look for new ideas when the backlog runs low" note="Not built yet: this is saved but does nothing. Research runs only when you press its button on the Research page." defaultChecked={s.research} />
      </section>
      <section aria-labelledby="auto-h" className="flex flex-col gap-4 rounded-card bg-surface p-pad">
        <h2 id="auto-h" className="text-title font-semibold">Automatic jobs</h2>
        <Check name="analytics" label="Pull analytics once a day (after 09:00 IST)" note="Read only. Uses a little YouTube quota." defaultChecked={s.analytics} />
        <Check name="competitors" label="Refresh watched competitors once a day" note="Checks the channels you watch for new videos, for the Research page. Free of paid calls; uses a little YouTube quota." defaultChecked={s.competitors} />
        <Check name="weekly_review" label="Weekly review" note="Writes a short report of last week's numbers on the Analytics page. Uses one small paid text call." defaultChecked={s.weekly_review} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor="weekly_day">Review day</Label>
            <select id="weekly_day" name="weekly_day" defaultValue={s.weekly_day} className={field}>
              {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          </div>
          <Num name="weekly_hour" label="Review hour (IST)" note="0 to 23." value={s.weekly_hour} min={0} max={23} />
        </div>
        <Check name="optimizer" label="Nightly optimizer" note="Suggests changes (titles, topics) on the Analytics page; you accept or dismiss them. Uses a small paid text call. Off by default." defaultChecked={s.optimizer} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Num name="optimizer_hour" label="Optimizer hour (IST)" note="0 to 23." value={s.optimizer_hour} min={0} max={23} />
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Save schedule</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : null}
      </div>
    </form>
  );
}
