"use client";

import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { swapClipAction, type RerunState } from "./actions";

/** "Try another clip" for one beat of a Montage. Free: the app searches again for that beat only, never the same clip. */
export function SwapClipForm({ videoId, beatId, disabled }: { videoId: string; beatId: string; disabled: boolean }) {
  const [state, run, pending] = useActionState<RerunState, FormData>(swapClipAction, {});
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="beatId" value={beatId} />
      <Button type="submit" variant="secondary" loading={pending} disabled={disabled} aria-label={`Try another clip for ${beatId}`}>Try another clip</Button>
      {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-small text-pill-positive-ink" : "m-0 text-small text-pill-negative-ink"}>{state.message}</p> : null}
    </form>
  );
}
