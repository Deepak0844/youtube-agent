"use client";

import { useActionState, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { writeTitlesAction, type SeoState } from "./seo-actions";

/** Copies one field to the clipboard. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        }, () => {});
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

/** "Write titles" / "Regenerate": queues the on-demand step. Free on the Claude Code route; otherwise it costs what the titles model costs. */
export function WriteTitlesForm({ videoId, again, disabled }: { videoId: string; again: boolean; disabled: boolean }) {
  const [state, run, pending] = useActionState<SeoState, FormData>(writeTitlesAction, {});
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <Button type="submit" variant="secondary" disabled={pending || disabled}>{again ? "Regenerate" : "Write titles"}</Button>
      {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
    </form>
  );
}
