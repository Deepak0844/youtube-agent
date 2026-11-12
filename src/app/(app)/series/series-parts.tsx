"use client";

import Link from "next/link";
import { useActionState } from "react";
import { cutStages } from "@/ui/domain/queue-strip";
import { CutStrip } from "@/ui/domain/cut-strip";
import { formatUsd } from "@/ui/domain/spend-line";
import { cn, control, fade, focusRing } from "@/ui/lib/cn";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { Pill } from "@/ui/primitives/pill";
import { Progress } from "@/ui/primitives/progress";
import { dropPartAction, movePartAction, planPartsAction, startPartAction, type SeriesFormState } from "./actions";

const areaClass = cn("w-full rounded-control border border-control bg-surface px-4 py-2 text-body text-text", control, fade, focusRing);

type StripProp = Parameters<typeof cutStages>[0];
export interface PartView {
  partNo: number;
  title: string;
  oneLine: string;
  format: "short" | "long";
  status: "planned" | "started" | "dropped";
  videoId: string | null;
  strip: StripProp | null;
  canUp: boolean;
  canDown: boolean;
}

const TONE = { no_limit: "neutral", ok: "positive", near: "warning", over: "negative" } as const;
const STATE_WORD = { no_limit: "No limit", ok: "Within cap", near: "Near the cap", over: "Cap reached" } as const;

/** "$1.20 of $5.00" with a bar, or "$1.20 so far, no limit". Text states the state; colour is a second channel. */
export function CostLine({ spentMicroUsd, capMicroUsd, state, pct, rate }: { spentMicroUsd: number; capMicroUsd: number | null; state: keyof typeof TONE; pct: number; rate: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="series-cost">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 text-body tabular-nums [overflow-wrap:anywhere]">
          {capMicroUsd === null ? `${formatUsd(spentMicroUsd, rate)} spent so far` : `${formatUsd(spentMicroUsd, rate)} of ${formatUsd(capMicroUsd, rate)} cap`}
        </span>
        <Pill tone={TONE[state]}>{STATE_WORD[state]}</Pill>
      </div>
      {capMicroUsd !== null ? <Progress value={pct} aria-label="Series spend against its cap" /> : null}
    </div>
  );
}

function Msg({ s }: { s: SeriesFormState }) {
  return s.error ? <p role="alert" className="m-0 text-small text-pill-negative-ink">{s.error}</p> : null;
}

export function PlanPartsForm({ seriesId }: { seriesId: string }) {
  const [state, run, pending] = useActionState<SeriesFormState, FormData>(planPartsAction, {});
  return (
    <form action={run} className="flex min-w-0 max-w-xl flex-col gap-3 rounded-card border border-border bg-surface p-pad">
      <h2 className="text-title font-semibold">Add episodes</h2>
      <input type="hidden" name="id" value={seriesId} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="episodes">One episode per line: title - one line about it</Label>
        <textarea id="episodes" name="episodes" rows={5} required className={areaClass} placeholder={"Arrays - How memory is laid out\nHash maps - Lookup in one step"} />
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" loading={pending}>Add to the plan</Button>
        <Msg s={state} />
      </div>
    </form>
  );
}

const STATUS_WORDS = { planned: "Planned", started: "Started", dropped: "Dropped" } as const;

export function PartCard({ seriesId, part }: { seriesId: string; part: PartView }) {
  const [startState, start, starting] = useActionState<SeriesFormState, FormData>(startPartAction, {});
  const [moveState, move, moving] = useActionState<SeriesFormState, FormData>(movePartAction, {});
  const [dropState, drop, dropping] = useActionState<SeriesFormState, FormData>(dropPartAction, {});
  const planned = part.status === "planned";
  const hidden = (
    <>
      <input type="hidden" name="id" value={seriesId} />
      <input type="hidden" name="part" value={part.partNo} />
    </>
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h3 className="m-0 min-w-0 break-words text-body font-semibold">{`Part ${part.partNo}: ${part.title}`}</h3>
        <Pill tone={part.status === "started" ? "positive" : "neutral"}>{`${STATUS_WORDS[part.status]}, ${part.format === "long" ? "long" : "short"}`}</Pill>
      </div>
      {part.oneLine ? <p className="m-0 break-words text-body text-muted">{part.oneLine}</p> : null}
      {part.strip ? <CutStrip format="short" aspect="9:16" stages={cutStages(part.strip)} thumbnail={false} layout="stack" /> : null}
      {part.videoId ? (
        <Link href={`/videos/${part.videoId}`} className="text-body underline underline-offset-4">Open the video</Link>
      ) : null}
      {planned ? (
        <div className="flex flex-wrap items-center gap-3">
          <form action={start}>
            {hidden}
            <Button type="submit" disabled={starting || part.format === "long"}>Start this part</Button>
          </form>
          <form action={move}>
            {hidden}
            <input type="hidden" name="dir" value="up" />
            <Button type="submit" variant="secondary" disabled={moving || !part.canUp}>Move up</Button>
          </form>
          <form action={move}>
            {hidden}
            <input type="hidden" name="dir" value="down" />
            <Button type="submit" variant="secondary" disabled={moving || !part.canDown}>Move down</Button>
          </form>
          <form action={drop}>
            {hidden}
            <Button type="submit" variant="ghost" disabled={dropping}>Drop</Button>
          </form>
        </div>
      ) : null}
      {planned && part.format === "long" ? <p className="m-0 text-small text-muted">Long videos come in a later release, so this part cannot start yet.</p> : null}
      <Msg s={startState} />
      <Msg s={moveState} />
      <Msg s={dropState} />
    </div>
  );
}
