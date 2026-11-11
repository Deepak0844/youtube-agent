import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { MIN_SHORTS_FOR_SIGNAL } from "@/server/core/analytics";
import { loadAnalytics, type AnalyticsRow } from "@/server/db/analytics";
import { getPool } from "@/server/db/pool";
import { Pill } from "@/ui/primitives/pill";
import { Insights } from "./insights";
import { PullForm } from "./pull-form";
import { TitleTests } from "./title-tests";

export const metadata = { title: "Analytics" };

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const int = new Intl.NumberFormat("en-IN");
const count = (v: number | null) => (v === null ? "—" : int.format(v));
const pct = (v: number | null, digits = 0) => (v === null ? "—" : `${v.toFixed(digits)}%`);
// The app has no rupee formatter yet (Phase 7), so spend is shown in US dollars.
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro > 0 && micro < 10_000 ? 4 : 2)}`;

function Row({ r }: { r: AnalyticsRow }) {
  return (
    <li data-testid="analytics-row" className="flex min-w-0 flex-col gap-2 rounded-card bg-surface p-pad">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{r.topic}</span>
        {r.error ? <Pill tone="warning">Pull had a problem</Pill> : r.pulledAtIst ? null : <Pill tone="neutral">Not pulled yet</Pill>}
      </div>
      <p className="m-0 text-small text-muted">{r.channelTitle ?? "channel not found"}</p>
      <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 text-body sm:grid-cols-5">
        <Stat label="Views" value={count(r.views)} />
        <Stat label="Likes" value={count(r.likes)} />
        <Stat label="Average % viewed" value={pct(r.avgViewPct, 1)} />
        <Stat label="Retention at 10%" value={r.retentionAt10 === null ? "—" : pct(r.retentionAt10 * 100)} />
        <Stat label="Spend on this video" value={usd(r.spendMicroUsd)} />
      </dl>
      {r.biggestDropBeat ? (
        <p className="m-0 text-body">
          Biggest drop: beat <strong>{r.biggestDropBeat}</strong> ({pct((r.biggestDrop ?? 0) * 100)} of viewers left there).
        </p>
      ) : r.hasCurve ? null : (
        <p className="m-0 text-small text-faint">No retention curve yet (YouTube needs some views first).</p>
      )}
      {r.error ? (
        <p role="note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink [overflow-wrap:anywhere]">
          {r.error}. Nothing is retried on its own: press Run now to try again.
        </p>
      ) : null}
      <p className="m-0 text-small text-faint">{r.pulledAtIst ? `Last pulled ${r.pulledAtIst} IST` : "Never pulled"}</p>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="m-0 font-semibold">{value}</dd>
    </div>
  );
}

async function Owned() {
  await requireOwner();
  const view = await loadAnalytics(getPool());
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-col gap-2">
        <h1 className="text-page-title font-semibold tracking-tight">Analytics</h1>
        <p className="max-w-[68ch] text-body text-muted">
          Numbers for videos uploaded to your connected channels. Press Run now to ask YouTube; this only reads, it never changes anything
          on YouTube. Spend is shown in US dollars for now (rupees arrive with the display settings).
        </p>
        <PullForm />
      </header>
      {view.noise && view.rows.length > 0 ? (
        <p role="note" data-testid="noise-note" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
          Only {view.shortsWithCurve} of your shorts {view.shortsWithCurve === 1 ? "has" : "have"} a retention curve. With fewer than {MIN_SHORTS_FOR_SIGNAL} shorts, treat
          the retention and biggest-drop numbers as noise.
        </p>
      ) : null}
      {view.rows.length === 0 ? (
        <p className="rounded-card bg-surface p-pad text-body text-muted">No uploaded videos yet. Once a short is uploaded, its numbers show here.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {view.rows.map((r) => (
            <Row key={r.videoId} r={r} />
          ))}
        </ul>
      )}
      <Insights />
      <TitleTests />
    </div>
  );
}
