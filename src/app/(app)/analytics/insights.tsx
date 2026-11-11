import { formatIst, formatMoney } from "@/server/core/display-format";
import { latestReview, listProposals } from "@/server/db/insights";
import { getPool } from "@/server/db/pool";
import { loadInrRate } from "@/server/db/system-settings";
import { Pill } from "@/ui/primitives/pill";
import { DecideForm, RunOptimizerForm, RunReviewForm } from "./insights-forms";

const pct = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="m-0 font-semibold">{value}</dd>
    </div>
  );
}

// Weekly review and optimizer proposals. Numbers come from our own data; a model only adds observations. Nothing here changes YouTube.
export async function Insights() {
  const db = getPool();
  const [review, proposals, rate] = await Promise.all([latestReview(db), listProposals(db), loadInrRate(db)]);
  const money = (micro: number) => formatMoney(micro, rate);
  const r = review?.report;
  return (
    <section aria-labelledby="insights-h" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 id="insights-h" className="text-title font-semibold">Weekly review</h2>
        <p className="max-w-[68ch] text-body text-muted">
          The numbers come from your own data. A model may add a few observations, never numbers. Nothing here changes anything on YouTube.
        </p>
        <RunReviewForm />
      </div>
      {!review || !r ? (
        <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No review yet. Press Run review now, or turn the weekly review on in Settings, Schedule.</p>
      ) : (
        <div data-testid="review" className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-pad">
          <p className="m-0 text-small text-muted">Week {review.week}, written {formatIst(review.createdAt)}</p>
          {r.lowConfidence ? (
            <p role="note" data-testid="low-confidence" className="m-0 max-w-[68ch] rounded-card bg-pill-warning-bg p-3 text-body text-pill-warning-ink">
              Low confidence: only {r.shortsWithData} short{r.shortsWithData === 1 ? "" : "s"} with analytics (fewer than {r.minSample}). Read these as numbers, not as a trend.
            </p>
          ) : null}
          <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2 text-body sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Shipped" value={String(r.shipped)} />
            <Stat label="Views" value={new Intl.NumberFormat("en-IN").format(r.views)} />
            <Stat label="Average % viewed" value={pct(r.avgViewPct)} />
            <Stat label="Spend (7 days)" value={money(r.spendMicroUsd)} />
            <Stat label="Cost per short" value={r.costPerShortMicroUsd === null ? "—" : money(r.costPerShortMicroUsd)} />
            <Stat label="Failures" value={String(r.failures)} />
          </dl>
          {r.beats.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-body font-semibold">Retention by beat</h3>
              <table className="w-full max-w-xl text-body">
                <thead><tr className="text-left text-small text-muted"><th className="py-1 pr-4 font-normal">Beat</th><th className="py-1 pr-4 font-normal">Audience lost</th><th className="py-1 font-normal">Shorts</th></tr></thead>
                <tbody>
                  {r.beats.map((b) => (
                    <tr key={b.beat} data-testid="beat-row"><td className="py-1 pr-4 [overflow-wrap:anywhere]">{b.beat}</td><td className="py-1 pr-4">{(b.avgDrop * 100).toFixed(0)}%</td><td className="py-1">{b.shorts}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {r.niches.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-body font-semibold">By niche</h3>
              <table className="w-full max-w-xl text-body">
                <thead><tr className="text-left text-small text-muted"><th className="py-1 pr-4 font-normal">Niche</th><th className="py-1 pr-4 font-normal">Shorts</th><th className="py-1 pr-4 font-normal">Views</th><th className="py-1 font-normal">Average % viewed</th></tr></thead>
                <tbody>
                  {r.niches.map((n) => (
                    <tr key={n.niche} data-testid="niche-row">
                      <td className="py-1 pr-4 [overflow-wrap:anywhere]">{n.niche}{n.lowConfidence ? <> <Pill tone="warning">low confidence</Pill></> : null}</td>
                      <td className="py-1 pr-4">{n.shorts}</td><td className="py-1 pr-4">{new Intl.NumberFormat("en-IN").format(n.views)}</td><td className="py-1">{pct(n.avgViewPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {review.notes.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-body font-semibold">Observations</h3>
              <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-body">
                {review.notes.map((n, i) => <li key={i} className="[overflow-wrap:anywhere]">{n}</li>)}
              </ul>
              {review.costMicroUsd > 0 ? <p className="m-0 text-small text-faint">Model cost: {money(review.costMicroUsd)}</p> : null}
            </div>
          ) : null}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <h2 className="text-title font-semibold">Proposals</h2>
        <p className="max-w-[68ch] text-body text-muted">Ideas from the optimizer. Accept or dismiss records your decision only; nothing is changed for you.</p>
        <RunOptimizerForm />
        {proposals.length === 0 ? (
          <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No proposals yet. The optimizer is off until you turn it on in Settings, Schedule, and it stays quiet below {r?.minSample ?? 10} shorts.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {proposals.map((p) => (
              <li key={p.id} data-testid="proposal-row" className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-pad">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill tone="neutral">{p.kind}</Pill>
                  <span className="min-w-0 text-body font-medium [overflow-wrap:anywhere]">{p.title}</span>
                  {p.status !== "open" ? <Pill tone={p.status === "accepted" ? "positive" : "neutral"}>{p.status}</Pill> : null}
                </div>
                {p.topic ? <p className="m-0 text-small text-muted [overflow-wrap:anywhere]">About: {p.topic}</p> : null}
                {p.detail ? <p className="m-0 max-w-[68ch] text-body [overflow-wrap:anywhere]">{p.detail}</p> : null}
                {p.status === "open" ? <DecideForm id={p.id} title={p.title} /> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
