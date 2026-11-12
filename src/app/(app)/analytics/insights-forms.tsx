"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { decideProposalAction, runOptimizerAction, runReviewAction, type InsightState } from "./insights-actions";

function Note({ state, testId }: { state: InsightState; testId: string }) {
  if (!state.message) return null;
  return (
    <p role="status" data-testid={testId} className={state.ok ? "text-body text-pill-positive-ink" : "text-body text-pill-negative-ink"}>
      {state.message}
    </p>
  );
}

export function RunOptimizerForm() {
  const [state, run, pending] = useActionState<InsightState, FormData>(() => runOptimizerAction(), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <Button type="submit" variant="secondary" loading={pending}>
        {pending ? "Thinking…" : "Run optimizer now"}
      </Button>
      <Note state={state} testId="optimizer-note" />
    </form>
  );
}

export function RunReviewForm() {
  const [state, run, pending] = useActionState<InsightState, FormData>(() => runReviewAction(), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <Button type="submit" loading={pending}>
        {pending ? "Writing…" : "Run review now"}
      </Button>
      <Note state={state} testId="review-note" />
    </form>
  );
}

export function DecideForm({ id, title }: { id: string; title: string }) {
  const [state, run, pending] = useActionState<InsightState, FormData>((_prev, form) => decideProposalAction(form), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" name="decision" value="accept" variant="secondary" loading={pending} aria-label={`Accept proposal: ${title}`}>
        Accept
      </Button>
      <Button type="submit" name="decision" value="dismiss" variant="ghost" loading={pending} aria-label={`Dismiss proposal: ${title}`}>
        Dismiss
      </Button>
      <Note state={state} testId="proposal-note" />
    </form>
  );
}
