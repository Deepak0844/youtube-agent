"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { CLIP_MAX_MS, CLIP_MIN_MS } from "@/server/core/derive-short";
import { boundsLengthMs, type ChapterClip } from "@/server/core/derive-view";
import { Button } from "@/ui/primitives/button";
import { makeShortAction, type DeriveState } from "./derive-actions";

const NUM = "w-24 rounded-control border border-control bg-ground px-3 py-2 text-body tabular-nums";
const TEXT = "w-full max-w-[40ch] rounded-control border border-control bg-ground px-3 py-2 text-body";
const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Choose a chapter or a run of scenes, see the length it would have, and make the short. The length is an estimate from the caption times; the cut checks the real file. */
export function MakeShortForm({ videoId, bounds, chapters }: { videoId: string; bounds: Array<[number, number]>; chapters: ChapterClip[] }) {
  const [state, run, pending] = useActionState<DeriveState, FormData>(makeShortAction, {});
  const [first, setFirst] = useState("1");
  const [last, setLast] = useState(String(Math.min(bounds.length, 2)));
  const len = boundsLengthMs(bounds, Number(first), Number(last));
  const usable = len !== null && len >= CLIP_MIN_MS && len <= CLIP_MAX_MS;
  const verdict = len === null ? `Pick scenes 1 to ${bounds.length}, the first not after the last.` : usable ? `About ${secs(len)}.` : len < CLIP_MIN_MS ? `About ${secs(len)}: a short must be at least ${secs(CLIP_MIN_MS)}.` : `About ${secs(len)}: a short from here is at most ${secs(CLIP_MAX_MS)}.`;
  return (
    <form action={run} data-testid="make-short" className="flex min-w-0 flex-col gap-3">
      <input type="hidden" name="videoId" value={videoId} />
      {chapters.length > 0 ? (
        <label className="flex flex-col gap-1 text-body">Start from a chapter
          <select defaultValue="" className={TEXT} onChange={(e) => { const c = chapters.find((x) => String(x.n) === e.target.value); if (c) { setFirst(String(c.firstScene)); setLast(String(c.lastScene)); } }}>
            <option value="">Pick a chapter to fill in the scenes</option>
            {chapters.map((c) => <option key={c.n} value={c.n}>Chapter {c.n}: {c.title} ({secs(c.lengthMs)}{c.problem ? ", not usable as it is" : ""})</option>)}
          </select>
        </label>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-body">First scene
          <input name="first" type="number" inputMode="numeric" min={1} max={bounds.length} value={first} onChange={(e) => setFirst(e.target.value)} className={NUM} required />
        </label>
        <label className="flex flex-col gap-1 text-body">Last scene
          <input name="last" type="number" inputMode="numeric" min={1} max={bounds.length} value={last} onChange={(e) => setLast(e.target.value)} className={NUM} required />
        </label>
        <p data-testid="clip-length" role="status" className={usable ? "m-0 pb-2 text-body text-pill-positive-ink" : "m-0 pb-2 text-body text-pill-warning-ink"}>{verdict}</p>
      </div>
      <label className="flex flex-col gap-1 text-body">Title (optional, defaults to this video&apos;s title)
        <input name="title" maxLength={200} className={TEXT} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !usable}>Make a short</Button>
        {state.message ? <p role={state.ok ? "status" : "alert"} className={state.ok ? "m-0 text-body text-pill-positive-ink" : "m-0 text-body text-pill-negative-ink"}>{state.message}</p> : null}
        {state.ok && state.videoId ? <Link href={`/videos/${state.videoId}`} className="text-body underline">Open the short</Link> : null}
      </div>
    </form>
  );
}
