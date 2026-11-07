"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { saveInrRateAction, type RateState } from "./rate-action";

export function RateForm({ rate }: { rate: number }) {
  const [state, action, pending] = useActionState<RateState, FormData>(saveInrRateAction, {});
  return (
    <section aria-labelledby="rate-h" className="rounded-card bg-surface p-pad">
      <h2 id="rate-h" className="text-title font-semibold">Rupee rate</h2>
      <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
        Amounts show in dollars with a rupee figure beside them. Spending limits and stored amounts stay in dollars; this rate only changes what is shown.
      </p>
      <form action={action} className="flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="inr_rate">Rupees per US dollar</Label>
          <Input id="inr_rate" name="inr_rate" type="text" inputMode="decimal" required defaultValue={String(rate)} />
        </div>
        <Button type="submit" disabled={pending}>Save</Button>
        {state.error ? <p role="alert" className="text-body text-pill-negative-ink">{state.error}</p> : state.ok ? <p role="status" className="text-body text-pill-positive-ink">Saved.</p> : null}
      </form>
    </section>
  );
}
