"use client";

import { useActionState } from "react";
import { CAPTION_STYLE_IDS, STYLE_IDS } from "../../../../../remotion/kit/presets";
import { LANGUAGE_ORDER, LANGUAGE_WORDS } from "@/server/core/videos-view";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { createSeriesAction, type SeriesFormState } from "../actions";

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text", control, fade, focusRing);
const areaClass = cn("w-full rounded-control border border-control bg-surface px-4 py-2 text-body text-text", control, fade, focusRing);
const words = (id: string) => id.replace(/_/g, " ");

export function NewSeriesForm({ channels }: { channels: ReadonlyArray<{ channelId: string; title: string }> }) {
  const [state, run, pending] = useActionState<SeriesFormState, FormData>(createSeriesAction, {});
  return (
    <form action={run} className="flex min-w-0 max-w-xl flex-col gap-4 rounded-card bg-surface p-pad">
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-title">Title</Label>
        <Input id="series-title" name="title" required minLength={3} maxLength={80} autoComplete="off" placeholder="Data structures in 40 seconds" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-premise">Premise (optional)</Label>
        <textarea id="series-premise" name="premise" rows={3} maxLength={1000} className={areaClass} />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-channel">Channel (optional)</Label>
        <select id="series-channel" name="channel" defaultValue="" className={selectClass}>
          <option value="">No channel</option>
          {channels.map((c) => (
            <option key={c.channelId} value={c.channelId}>{c.title || c.channelId}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-language">Narration language</Label>
        <select id="series-language" name="language" defaultValue="en" className={selectClass}>
          {LANGUAGE_ORDER.map((l) => (
            <option key={l} value={l}>{LANGUAGE_WORDS[l]}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-formats">Formats allowed</Label>
        <select id="series-formats" name="formats" defaultValue="short" className={selectClass}>
          <option value="short">Shorts only</option>
          <option value="long">Long videos only (starting them comes later)</option>
          <option value="mixed">Mixed</option>
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-style">Look (optional)</Label>
        <select id="series-style" name="style" defaultValue="" className={selectClass}>
          <option value="">Default look</option>
          {STYLE_IDS.map((s) => (
            <option key={s} value={s}>{words(s)}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-caption">Caption style (optional)</Label>
        <select id="series-caption" name="captionStyle" defaultValue="" className={selectClass}>
          <option value="">Default captions</option>
          {CAPTION_STYLE_IDS.map((s) => (
            <option key={s} value={s}>{words(s)}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-voice">Voice id (optional)</Label>
        <Input id="series-voice" name="voice" maxLength={64} autoComplete="off" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="series-cap">Spend cap in dollars (empty = no limit)</Label>
        <Input id="series-cap" name="capUsd" type="number" inputMode="decimal" min={0} step={0.5} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>Create series</Button>
        {state.error ? <p role="alert" className="m-0 text-body text-pill-negative-ink">{state.error}</p> : null}
      </div>
    </form>
  );
}
