import { Suspense } from "react";
import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth/require-owner";
import { DecisionRow } from "@/ui/domain/decision-row";
import { KpiStrip } from "@/ui/domain/kpi-strip";
import { SpendLine, formatUsd } from "@/ui/domain/spend-line";
import { aspectFor, stagesFor, type CutStage } from "@/ui/domain/stages";
import { sample, type SampleVideo } from "@/ui/sample/data";
import { dayTotal, monthTotal, videoCost } from "@/ui/sample/reconcile";

// The Home screen (Doc 3 §6) against made-up data. Dev/staging only, never in the nav.
export default function DevHome() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  if (process.env.NODE_ENV === "production") notFound();
  return <HomeSample />;
}

// Stages before the held one are done; the held one carries the gate. Gate names are the stage that asks.
const HOLD_AT: Record<string, string> = { outline: "outline", script: "draft", cost: "build", video: "review" };

function stagesOf(v: SampleVideo): CutStage[] {
  const defs = stagesFor(v.format);
  const at = v.gate ? defs.findIndex((s) => s.key === HOLD_AT[v.gate!]) : -1;
  return defs.map((s, i) => {
    if (v.status === "done") return { ...s, state: "done" };
    if (v.gate && i === at) return { ...s, state: "held", gate: v.gate };
    if (v.gate && i < at) return { ...s, state: "done" };
    return { ...s, state: "todo" };
  });
}

function HomeSample() {
  const queue = sample.videos.filter((v) => v.status === "held");
  const channel = (id: string) => sample.channels.findIndex((c) => c.id === id);
  return (
    <div data-testid="dev-ui" className="grid gap-layout xl:grid-cols-[1fr_384px]">
      <div className="flex min-w-0 flex-col gap-layout">
        <h1 className="text-page-title font-semibold tracking-tight">Home (sample)</h1>
        <KpiStrip
          lead={{ label: "Waiting on you", value: queue.length }}
          figures={[
            { label: "In production", value: sample.videos.filter((v) => v.status === "running").length },
            { label: "Published this month", value: sample.videos.filter((v) => v.status === "done").length },
            { label: "Spent this month", value: formatUsd(monthTotal(sample)) },
          ]}
        />
        <section aria-labelledby="queue-h" className="flex flex-col gap-gap">
          <h2 id="queue-h" className="text-title font-semibold">Decision queue</h2>
          {queue.map((v) => (
            <DecisionRow
              key={v.id}
              title={v.title}
              lang={v.lang}
              format={v.format}
              aspect={aspectFor(v.format)}
              stages={stagesOf(v)}
              gateLabel={`${v.gate![0]!.toUpperCase()}${v.gate!.slice(1)} gate`}
              costLabel={formatUsd(videoCost(sample, v.id))}
              ageLabel="today"
              href="/dev/ui/video"
              channelName={sample.channels.find((c) => c.id === v.channelId)!.name}
              channelIndex={channel(v.channelId)}
            />
          ))}
        </section>
      </div>
      <aside aria-label="Rail" className="flex min-w-0 flex-col gap-gap">
        <section aria-labelledby="spend-h" className="flex flex-col gap-3 rounded-card bg-surface p-pad">
          <h2 id="spend-h" className="text-title font-semibold">Spend</h2>
          <SpendLine spentMicroUsd={dayTotal(sample)} capMicroUsd={sample.budget.dayCapMicroUsd} />
        </section>
        <section aria-labelledby="gates-h" className="flex flex-col gap-3 rounded-card bg-surface p-pad">
          <h2 id="gates-h" className="text-title font-semibold">Gates</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-body">
            {sample.gates.map((g) => (
              <li key={g.name} className="flex justify-between gap-4"><span className="capitalize">{g.name}</span><span className="tabular-nums text-muted">{g.waiting}</span></li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
