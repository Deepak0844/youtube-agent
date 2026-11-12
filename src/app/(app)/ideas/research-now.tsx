"use client";

import { useActionState } from "react";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { researchNowAction, type ResearchNowState } from "./research-actions";

const selectClass = cn("rounded-control border border-control bg-surface px-4 text-body text-text disabled:opacity-50", control, fade, focusRing);

export function ResearchNowForm({ channels }: { channels: ReadonlyArray<{ channelId: string; title: string }> }) {
  const [state, run, pending] = useActionState<ResearchNowState, FormData>((_prev, form) => researchNowAction(form), {});
  return (
    <form action={run} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="research-channel">Channel</Label>
        <select id="research-channel" name="channel" defaultValue="" className={selectClass}>
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>{c.title || c.channelId}</option>
          ))}
        </select>
      </div>
      <Button type="submit" loading={pending}>
        {pending ? "Researching…" : "Research now"}
      </Button>
      <p className="m-0 basis-full text-small text-muted">
        One capped model call (up to $0.30) per channel, using that channel&apos;s description, videos, watched competitors and the shared trends. &quot;All channels&quot; skips channels with 5 or more ideas waiting or researched in the last 20 hours. It adds ideas to the backlog; nothing is drafted.
      </p>
      {state.message ? (
        <p role="status" data-testid="research-note" className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
