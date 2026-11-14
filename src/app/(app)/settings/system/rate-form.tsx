"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveInrAutoAction, saveInrRateAction, updateInrRateNowAction, type RateState } from "./rate-action";

export function RateForm({ rate, auto, note, credits }: { rate: number; auto: boolean; /** Where the rate came from, already in words (IST), or null when typed by hand. */ note: string | null; credits: string }) {
  const [state, action, pending] = useActionState<RateState, FormData>(saveInrRateAction, {});
  const [autoState, autoAction, autoPending] = useActionState<RateState, FormData>(saveInrAutoAction, {});
  const [nowState, nowAction, nowPending] = useActionState<RateState, FormData>(updateInrRateNowAction, {});
  return (
    <section aria-labelledby="rate-h" className="rounded-card border border-border bg-surface p-pad">
      <h2 id="rate-h" className="text-title font-semibold">Rupee rate</h2>
      <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
        Amounts show in dollars with a rupee figure beside them. Spending limits and stored amounts stay in dollars; this rate only changes what is shown.
      </p>
      <form action={action} className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="inr_rate">Rupees per US dollar</Label>
          <Input id="inr_rate" name="inr_rate" type="text" inputMode="decimal" required defaultValue={String(rate)} />
        </div>
        <Button type="submit" loading={pending}>Save</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : null}
      </form>
      <p data-testid="rate-note" className="mt-3 mb-0 max-w-[60ch] text-body text-muted">{note ?? "This rate was typed by you."}</p>
      <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
        <form action={autoAction} className="flex flex-wrap items-center gap-4">
          <label className="flex min-h-11 items-center gap-3 text-body">
            <input type="checkbox" name="auto" defaultChecked={auto} className="size-5 accent-[var(--text)]" />
            Update the rate automatically each day (about 9 am IST)
          </label>
          <Button type="submit" loading={autoPending}>Save</Button>
          {autoState.error ? <p role="alert" className="text-body text-pill-negative-ink">{autoState.error}</p> : autoState.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : null}
        </form>
        <form action={nowAction} className="flex flex-wrap items-center gap-4">
          <Button type="submit" loading={nowPending}>Update now</Button>
          {nowState.error ? <p role="alert" className="text-body text-pill-negative-ink">{nowState.error}</p> : nowState.ok ? <p role="status" className="text-body text-pill-positive-ink">Updated.</p> : null}
        </form>
        <p className="m-0 max-w-[60ch] text-small text-muted">
          Free public rate services, no account and no AI: {credits}. A typed rate is replaced at the next automatic update unless you turn this off.
        </p>
      </div>
    </section>
  );
}
