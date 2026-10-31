"use client";

import { useActionState } from "react";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { createVideoAction, type NewVideoState } from "./actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text disabled:opacity-50", control, fade, focusRing);

export function NewForm() {
  const [state, run, pending] = useActionState<NewVideoState, FormData>(createVideoAction, {});
  return (
    <form action={run} className="flex max-w-xl min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Label htmlFor="topic">Topic</Label>
        <Input id="topic" name="topic" required maxLength={200} placeholder="Why is the sky blue?" aria-describedby="topic-help" autoComplete="off" />
        <p id="topic-help" className="m-0 text-small text-faint">Up to 200 characters.</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="language">Narration language</Label>
        <select id="language" name="language" defaultValue="en" className={selectClass}>
          {LANGUAGE_ORDER.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_WORDS[l]} ({l})
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="kind">Kind</Label>
          <select id="kind" name="kind" defaultValue="scene_kit" className={selectClass}>
            <option value="scene_kit">Scene kit</option>
            <option value="tsx" disabled>TSX (later)</option>
            <option value="collage" disabled>Collage (later)</option>
            <option value="ai" disabled>AI (later)</option>
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="format">Format</Label>
          <select id="format" name="format" defaultValue="short" className={selectClass}>
            <option value="short">Short</option>
            <option value="long" disabled>Long (Phase 6b)</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <textarea id="notes" name="notes" rows={4} maxLength={2000} placeholder="Angle, tone, things to include or avoid" className={cn(selectClass, "py-2")} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Starting..." : "Start video"}
        </Button>
        {state.message ? (
          <p role="alert" className="m-0 text-body text-pill-negative-ink">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
