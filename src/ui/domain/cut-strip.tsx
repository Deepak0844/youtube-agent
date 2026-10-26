import * as React from "react";
import { cn } from "../lib/cn";
import type { Aspect, CutStage, Format, StageStatus } from "./stages";

const WRAP = "[overflow-wrap:anywhere]";

/** Shape carries the state, the word confirms it, colour is only the third channel. */
const SEG: Record<StageStatus, string> = {
  done: "h-5 bg-muted", // solid, neutral
  running: "h-5 bg-raised overflow-hidden", // track with an amber fill
  held: "h-5 bg-ground outline-2 -outline-offset-2 outline-text", // outlined
  failed: "h-5 bg-pill-negative-bg text-pill-negative-ink", // cross inside
  todo: "h-1 bg-raised", // thin: not started
};

const WORD: Record<StageStatus, string> = {
  done: "done",
  running: "running",
  held: "held",
  failed: "failed",
  todo: "waiting",
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function stateWord(s: CutStage): string {
  if (s.state === "running" && s.progress !== undefined) return `running ${clamp(s.progress)}%`;
  if (s.state === "held" && s.gate) return `held at ${s.gate}`;
  return WORD[s.state];
}

export function summarise(stages: CutStage[]): string {
  const failed = stages.find((s) => s.state === "failed");
  if (failed) return `Failed at ${failed.label}`;
  const held = stages.find((s) => s.state === "held");
  if (held) return held.gate ? `Held at the ${held.gate} gate` : `Held at ${held.label}`;
  const running = stages.find((s) => s.state === "running");
  if (running) return `Running: ${running.label}${running.progress !== undefined ? ` ${clamp(running.progress)}%` : ""}`;
  if (stages.length > 0 && stages.every((s) => s.state === "done")) return "All stages done";
  return "Not started";
}

function Cross() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden className="absolute inset-0 m-auto">
      <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Segment({ stage }: { stage: CutStage }) {
  const pct = clamp(stage.progress ?? 0);
  const chapters = stage.chapters ?? [];
  return (
    <li data-state={stage.state} className="flex min-w-0 flex-1 flex-col gap-1">
      <span data-seg className={cn("relative block w-full rounded-[3px]", SEG[stage.state])}>
        {stage.state === "running" && (
          <span
            role="progressbar"
            aria-label={`${stage.label} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="block h-full bg-accent motion-safe:animate-pulse"
            style={{ width: `${pct}%` }}
          />
        )}
        {stage.state === "failed" && <Cross />}
      </span>
      <span className={cn("min-w-0 text-[11px] leading-tight text-muted", WRAP)}>{stage.label}</span>
      <span className={cn("sr-only", WRAP)}>{stateWord(stage)}</span>
      {chapters.length > 0 && (
        <span role="img" aria-label={`${chapters.length} chapters, ${chapters.filter((c) => c === "done").length} done`} className="flex gap-px">
          {chapters.map((c, i) => (
            <span
              key={i}
              data-chapter={c}
              className={cn("h-[3px] min-w-0 flex-1", c === "done" ? "bg-muted" : c === "running" ? "bg-accent" : c === "failed" ? "bg-negative" : c === "held" ? "bg-text" : "bg-raised")}
            />
          ))}
        </span>
      )}
    </li>
  );
}

export interface CutStripProps {
  format: Format;
  stages: CutStage[];
  aspect: Aspect;
  /** A node (the frame) to show in the thumbnail slot, `false` to leave it out. */
  thumbnail?: React.ReactNode | false;
  /** "stack": thumbnail above the strip. "inline": thumbnail beside it (list rows). */
  layout?: "stack" | "inline";
  className?: string;
}

/** The signature element: one video as the stages that apply to it. Server-rendered, no chart library. */
export function CutStrip({ format, stages, aspect, thumbnail, layout = "stack", className }: CutStripProps) {
  const portrait = aspect === "9:16";
  return (
    <div className={cn("flex min-w-0 gap-3", layout === "stack" ? "flex-col" : "flex-row items-end", className)} data-format={format}>
      {thumbnail !== false && (
        <div
          data-thumb
          className={cn("shrink-0 overflow-hidden rounded-[6px] bg-raised", portrait ? "aspect-[9/16] w-11" : "aspect-video w-20", layout === "stack" && (portrait ? "w-16" : "w-32"))}
        >
          {thumbnail}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <ol aria-label="Stages" className="flex min-w-0 items-end gap-1">
          {stages.map((s) => (
            <Segment key={s.key} stage={s} />
          ))}
        </ol>
        <p className={cn("min-w-0 text-small text-muted", WRAP)}>{summarise(stages)}</p>
      </div>
    </div>
  );
}
