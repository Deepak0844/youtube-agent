"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { cutClipsAction, makeClipShortsAction, type ClipsState } from "./clips-actions";

const note = (s: ClipsState) =>
  s.message ? <p role={s.ok ? "status" : "alert"} className={s.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{s.message}</p> : null;

/** "Cut clips": queues the free, local clips step. Each press makes a NEW batch; older batches stay. */
export function CutClipsForm({ videoId, again, disabled }: { videoId: string; again: boolean; disabled: boolean }) {
  const [state, run, pending] = useActionState<ClipsState, FormData>(cutClipsAction, {});
  return (
    <form action={run} className="flex min-w-0 flex-wrap items-center gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      <Button type="submit" variant="secondary" disabled={pending || disabled}>{again ? "Cut a new batch" : "Cut clips"}</Button>
      {note(state)}
    </form>
  );
}

export interface ClipCard {
  id: string;
  hook: string;
  durationS: number;
  src: string | null;
  warnings: string[];
  short: { id: string; topic: string; status: string } | null;
}

/** The newest batch: a player per clip, its warnings in plain words, a tick to include it, and one button that makes a Short of each ticked clip. */
export function ClipBatchForm({ videoId, batch, clips }: { videoId: string; batch: number; clips: ClipCard[] }) {
  const [state, run, pending] = useActionState<ClipsState, FormData>(makeClipShortsAction, {});
  const open = clips.filter((c) => c.short === null);
  return (
    <form action={run} className="flex min-w-0 flex-col gap-4">
      <input type="hidden" name="videoId" value={videoId} />
      <input type="hidden" name="batch" value={batch} />
      <ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {clips.map((c) => (
          <li key={c.id} data-testid="clip-card" className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-pad">
            {c.src ? <video src={c.src} controls preload="none" playsInline className="aspect-[9/16] max-h-96 w-full rounded-card bg-black" aria-label={`Clip ${c.id}`} /> : <p className="m-0 text-small text-muted">No player (the vault is locked).</p>}
            <p className="m-0 text-body font-medium">{c.hook}</p>
            <p className="m-0 text-small tabular-nums text-muted">{Math.round(c.durationS)} s</p>
            {c.warnings.length === 0 ? <Pill tone="positive">All checks passed</Pill> : <ul className="m-0 flex list-none flex-col gap-1 p-0">{c.warnings.map((w) => <li key={w}><Pill tone="warning">Check</Pill> <span className="text-small">{w}</span></li>)}</ul>}
            {c.short ? (
              <p className="m-0 text-small">Short made: <Link href={`/videos/${c.short.id}`} className="underline">{c.short.topic}</Link> <span className="text-muted">({c.short.status})</span></p>
            ) : (
              <label className="flex min-h-11 items-center gap-2 text-body sm:min-h-9">
                <input type="checkbox" name="clipId" value={c.id} defaultChecked={c.warnings.length === 0} className="size-5" />
                Make a Short of this clip
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || open.length === 0}>Make Shorts of the ticked clips</Button>
        {note(state)}
      </div>
      <p className="m-0 text-small text-muted">Nothing is approved or published. Each Short waits for you to approve its script, then its video, evidence and publish steps like any other Short. Clips with a warning start unticked.</p>
    </form>
  );
}
