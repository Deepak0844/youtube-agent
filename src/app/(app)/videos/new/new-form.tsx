"use client";

import { useActionState } from "react";
import { LOOKS } from "../../../../../remotion/kit/look";
import { DEFAULT_STYLE, PRESETS, STYLE_IDS } from "../../../../../remotion/kit/presets";
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
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-body font-medium">Style</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {STYLE_IDS.map((id) => {
            const s = PRESETS[id];
            const sw = s.look ? [s.look.from, s.look.to, s.look.accent] : LOOKS.slice(0, 3).map((l) => l.to);
            return (
              <label key={id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-rule bg-surface p-3 has-checked:outline-2 has-checked:outline">
                <input type="radio" name="style" value={id === DEFAULT_STYLE ? "" : id} defaultChecked={id === DEFAULT_STYLE} className="mt-1" />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center gap-2 text-body font-medium">
                    <span aria-hidden className="flex">{sw.map((c) => <span key={c} className="size-4 first:rounded-l-full last:rounded-r-full" style={{ background: c }} />)}</span>
                    {s.label}
                  </span>
                  <span className="text-small text-muted">{s.mood}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <label className="flex items-start gap-3 text-body">
        <input type="checkbox" name="captionStyle" value="punchy_captions" className="mt-1" />
        <span>Punchy captions <span className="block text-small text-muted">Big 1-3 word captions, yellow active word, black outline. Works with any style.</span></span>
      </label>
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
