import { microToUsd } from "@/server/core/llm-catalog";
import type { DecisionItem } from "@/server/db/queue-data";
import { CutStrip } from "@/ui/domain/cut-strip";
import { cutStages } from "@/ui/domain/queue-strip";
import { Pill } from "@/ui/primitives/pill";
import { ageLabel } from "./gate-card";
import { DecisionForm } from "./forms";

const CHOICE: Record<string, { label: string; hint: string; variant: "primary" | "secondary" | "destructive"; check: boolean }> = {
  release_and_rerun: { label: "Nothing was charged: run it again", hint: "Choose this only after you checked the provider's billing page and saw no charge. The held money is released and the step runs again with new call keys.", variant: "primary", check: true },
  keep_spent_and_rerun: { label: "It was charged: count it and run again", hint: "The held amount is counted as spent, then the step runs again.", variant: "secondary", check: true },
  use_result: { label: "Use the result", hint: "Every paid call finished. Carry on with what was paid for, without paying again.", variant: "primary", check: false },
  cancel_video: { label: "Cancel this video", hint: "Stops the video. Money that may have been charged stays counted until you release it.", variant: "destructive", check: false },
};

export function DecisionCard({ item }: { item: DecisionItem }) {
  const d = item.decision;
  const fields = { stageRunId: d.stageRunId, seenMaxMicroUsd: String(d.maxCostMicroUsd), seenReason: d.reason };
  const shown = d.choices.filter((c) => c in CHOICE);
  return (
    <article aria-label={`Needs your decision: ${item.topic}`} data-testid="decision-card" data-video={item.videoId} className="flex min-w-0 flex-col gap-5 rounded-card bg-surface p-pad">
      <header className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone="negative">Needs your decision</Pill>
          <span className="text-small text-faint">parked {ageLabel(item.waitingSince)} ago</span>
        </div>
        <h2 lang={item.language} className="m-0 min-w-0 text-title font-semibold leading-tight [overflow-wrap:anywhere]">{item.topic}</h2>
        <CutStrip format="short" aspect="9:16" stages={cutStages(item.strip)} thumbnail={false} layout="stack" />
      </header>
      <p className="m-0 flex flex-wrap items-baseline gap-3">
        <span data-testid="decision-figure" className="text-kpi font-semibold tabular-nums">${microToUsd(d.maxCostMicroUsd)}</span>
        <span className="text-body text-muted">the most this could have cost</span>
      </p>
      <p data-testid="decision-summary" className="m-0 max-w-[68ch] text-body [overflow-wrap:anywhere]">{d.summary}</p>
      {d.reason === "budget_refused" ? (
        <p role="note" className="m-0 max-w-[68ch] text-body text-muted">Raising a spending limit lives on the Budgets page, which arrives in a later phase. Until then you can cancel this video.</p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-3">
        {shown.map((c) => (
          <DecisionForm key={c} fields={fields} choice={c} label={CHOICE[c]!.label} hint={CHOICE[c]!.hint} variant={CHOICE[c]!.variant} needsCheck={CHOICE[c]!.check} />
        ))}
      </div>
    </article>
  );
}
