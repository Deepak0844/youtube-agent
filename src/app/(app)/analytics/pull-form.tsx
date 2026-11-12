"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { pullAnalyticsAction, type PullState } from "./actions";

export function PullForm() {
  const [state, run, pending] = useActionState<PullState, FormData>(() => pullAnalyticsAction(), {});
  return (
    <form action={run} className="flex flex-wrap items-center gap-3">
      <Button type="submit" loading={pending}>
        {pending ? "Pulling…" : "Run now"}
      </Button>
      {state.message ? (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-body text-pill-positive-ink" : "text-body text-pill-negative-ink"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
