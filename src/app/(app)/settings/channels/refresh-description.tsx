"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { refreshDescriptionAction, type RefreshDescriptionState } from "./refresh-description-actions";

// Reads the channel's description from YouTube so the idea researcher can use it. Needs a connected channel.
export function RefreshDescription({ id }: { id: string }) {
  const [state, run, pending] = useActionState<RefreshDescriptionState, FormData>(refreshDescriptionAction, {});
  return (
    <form action={run} className="flex basis-full flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={id} />
      <Button type="submit" variant="secondary" disabled={pending}>{pending ? "Reading…" : "Refresh description"}</Button>
      <span className="text-small text-muted">Reads this channel&apos;s description from YouTube (1 quota unit) for idea research.</span>
      {state.message ? <span role="status" className={state.ok ? "text-small text-pill-positive-ink" : "text-small text-pill-negative-ink"}>{state.message}</span> : null}
    </form>
  );
}
