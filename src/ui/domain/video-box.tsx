import * as React from "react";
import { cn } from "../lib/cn";
import type { Aspect } from "./stages";

/** The largest object on a video's page, in the video's own aspect. Children are the frame; none = an honest hole. */
export function VideoBox({ aspect, label, children, className }: { aspect: Aspect; label: string; children?: React.ReactNode; className?: string }) {
  return (
    <figure aria-label={label} className={cn("m-0 w-full", aspect === "9:16" ? "max-w-[360px]" : "max-w-[960px]", className)}>
      <div
        data-aspect={aspect}
        className={cn("relative flex w-full items-center justify-center overflow-hidden rounded-card bg-surface", aspect === "9:16" ? "aspect-[9/16]" : "aspect-video")}
      >
        {children ?? <span className="p-pad text-center text-body text-muted [overflow-wrap:anywhere]">No frame rendered yet</span>}
      </div>
    </figure>
  );
}
