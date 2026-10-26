import * as React from "react";
import { cn, focusRing } from "../lib/cn";
import type { Aspect } from "./stages";

export interface Frame {
  /** Timecode, e.g. "0:07". */
  time: string;
  /** The frame image, if rendered. */
  node?: React.ReactNode;
}

/** A row of frames with timecodes. Scrolls sideways; the region is focusable so a keyboard can scroll it. */
export function FrameStrip({ frames, aspect, className }: { frames: Frame[]; aspect: Aspect; className?: string }) {
  if (frames.length === 0) return <p className="m-0 text-body text-muted">No frames yet.</p>;
  const portrait = aspect === "9:16";
  return (
    <div role="region" aria-label="Frames" tabIndex={0} className={cn("overflow-x-auto rounded-[6px]", focusRing, className)}>
      <ul className="m-0 flex w-max list-none gap-2 p-0">
        {frames.map((f, i) => (
          <li key={`${f.time}-${i}`} className="flex flex-col gap-1">
            <div className={cn("overflow-hidden rounded-[6px] bg-raised", portrait ? "aspect-[9/16] w-14" : "aspect-video w-28")}>{f.node}</div>
            <span className="text-small tabular-nums text-muted">{f.time}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
