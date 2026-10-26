import * as React from "react";
import { cn } from "../lib/cn";
import type { Aspect } from "./stages";

/** An empty section keeps its frame: a trade-words sentence and the one action. Pass `aspect` for a video-shaped hole. */
export function EmptyFrame({ message, action, aspect, className }: { message: string; action?: React.ReactNode; aspect?: Aspect; className?: string }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-start justify-center gap-4 rounded-card bg-surface p-pad",
        aspect === "9:16" && "aspect-[9/16] max-w-[220px]",
        aspect === "16:9" && "aspect-video",
        !aspect && "min-h-[120px]",
        className,
      )}
    >
      <p className="min-w-0 max-w-[36ch] text-section text-muted [overflow-wrap:anywhere]">{message}</p>
      {action}
    </div>
  );
}
