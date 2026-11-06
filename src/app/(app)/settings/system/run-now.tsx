"use client";

import { useActionState } from "react";
import { pullAnalyticsAction, type PullState } from "@/app/(app)/analytics/actions";
import { syncCommentsAction } from "@/app/(app)/engagement/actions";
import { Button } from "@/ui/primitives/button";

// Same owner-only, audit-logged actions as the Analytics and Engagement pages (read from YouTube; nothing is posted or published).
function RunNow({ label, run }: { label: string; run: () => Promise<PullState> }) {
  const [state, act, pending] = useActionState<PullState, FormData>(() => run(), {});
  return (
    <form action={act} className="flex flex-wrap items-center gap-3 py-1">
      <Button type="submit" disabled={pending}>{pending ? "Running…" : label}</Button>
      {state.message ? (
        <p role={state.ok ? "status" : "alert"} className={state.ok ? "text-body text-pill-positive-ink" : "text-body text-pill-negative-ink"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function RunNowForms() {
  return (
    <div className="flex flex-col">
      <RunNow label="Pull analytics now" run={pullAnalyticsAction} />
      <RunNow label="Sync comments now" run={syncCommentsAction} />
    </div>
  );
}
