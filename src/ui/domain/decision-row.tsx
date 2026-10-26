import * as React from "react";
import { cn } from "../lib/cn";
import { Button } from "../primitives/button";
import { Pill } from "../primitives/pill";
import { ChannelInitial } from "./channel-initial";
import { CutStrip } from "./cut-strip";
import type { Aspect, CutStage, Format } from "./stages";

export interface DecisionRowProps {
  title: string;
  /** BCP-47 language of the title, so the right Noto face and shaping are used. */
  lang: string;
  format: Format;
  aspect: Aspect;
  stages: CutStage[];
  gateLabel: string;
  costLabel: string;
  ageLabel: string;
  href: string;
  channelName: string;
  channelIndex: number;
  thumbnail?: React.ReactNode;
  className?: string;
}

/** One line of the decision queue: the Cut strip, what is waiting, what it costs, and the way in. */
export function DecisionRow(p: DecisionRowProps) {
  return (
    <article className={cn("grid min-w-0 gap-x-6 gap-y-3 rounded-card bg-surface p-pad md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] md:items-center", p.className)}>
      <CutStrip format={p.format} aspect={p.aspect} stages={p.stages} thumbnail={p.thumbnail} layout="inline" />
      <div className="flex min-w-0 flex-col gap-1">
        <p lang={p.lang} className="min-w-0 text-section font-medium leading-snug [overflow-wrap:anywhere]">
          {p.title}
        </p>
        <p className="min-w-0 text-small text-muted [overflow-wrap:anywhere]">{p.gateLabel}</p>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-small text-muted">
          <Pill>{p.format === "long" ? "Long" : "Short"}</Pill>
          <ChannelInitial name={p.channelName} index={p.channelIndex} className="size-5" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{p.channelName}</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 md:justify-end">
        <p className="m-0 flex flex-col text-right text-small text-muted tabular-nums">
          <span className="text-body text-text">{p.costLabel}</span>
          <span>{p.ageLabel}</span>
        </p>
        <Button asChild>
          <a href={p.href} aria-label={`Review ${p.title}`}>
            Review
          </a>
        </Button>
      </div>
    </article>
  );
}
