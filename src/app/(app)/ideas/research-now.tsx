"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { researchNowAction, type ResearchNowState } from "./research-actions";

export function ResearchNowForm() {
  const [state, run, pending] = useActionState<ResearchNowState, FormData>(() => researchNowAction(), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <Button type="submit" disabled={pending}>
        {pending ? "Researching…" : "Research now"}
      </Button>
      <p className="m-0 text-small text-muted">One capped model call (up to $0.30) over your topics, trends and competitor videos. It adds ideas to the backlog; nothing is drafted.</p>
      {state.message ? (
        <p role="status" data-testid="research-note" className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
