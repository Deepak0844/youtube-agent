import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { agoLabel, attentionText, gateLabel, spendSentence, stageLabel } from "@/server/core/home-view";
import { getPool } from "@/server/db/pool";
import { loadActive, loadAttention, loadBreakers, loadKpis, loadRecent, loadUpNext } from "@/server/db/home-data";
import { loadQueue } from "@/server/db/queue-data";
import { DecisionRow } from "@/ui/domain/decision-row";
import { KpiStrip } from "@/ui/domain/kpi-strip";
import { SpendLine, formatUsd } from "@/ui/domain/spend-line";
import { cutStages } from "@/ui/domain/queue-strip";
import { aspectFor } from "@/ui/domain/stages";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";
import { BreakerForm } from "./queue/forms";
import { LiveFeed } from "./queue/live-feed";

// Home (Doc 4 section 2, "/"): every panel reads on its own inside its own <Suspense>, and a panel that cannot load says so
// without taking the others down. Nothing here acts except the existing "Release" button on a paused step.
const SHOWN = 5;
const card = "flex min-w-0 flex-col gap-3 rounded-card bg-surface p-pad";

export default function Home() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-page-title font-semibold tracking-tight">Home</h1>
        <div className="flex flex-wrap gap-3">
          <Button asChild><Link href="/videos/new?format=short">New short</Link></Button>
          <Button asChild variant="secondary"><Link href="/videos">Library</Link></Button>
        </div>
      </div>
      <LiveFeed />
      <Panel id="breakers" title="Paused steps" bare><Breakers /></Panel>
      <Panel id="kpis" title="This month"><Kpis /></Panel>
      <div className="grid min-w-0 gap-layout xl:grid-cols-[1fr_384px]">
        <div className="flex min-w-0 flex-col gap-layout">
          <Panel id="queue" title="Decision queue"><Queue /></Panel>
          <Panel id="attention" title="Needs attention"><Attention /></Panel>
          <Panel id="active" title="Active work"><Active /></Panel>
          <Panel id="next" title="Up next"><UpNext /></Panel>
        </div>
        <aside aria-label="Recent activity" className="flex min-w-0 flex-col gap-layout">
          <Panel id="recent" title="Recent activity"><Recent /></Panel>
        </aside>
      </div>
    </div>
  );
}

function Panel({ id, title, bare, children }: { id: string; title: string; bare?: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} data-testid={`panel-${id}`} className={bare ? "flex min-w-0 flex-col gap-3" : card}>
      <h2 id={`${id}-h`} className={bare ? "sr-only" : "text-title font-semibold"}>{title}</h2>
      <Suspense fallback={<Skeleton className="h-20" />}>{children}</Suspense>
    </section>
  );
}

/** Runs one panel's read. A failure is logged (name only) and shown as a sentence; the other panels carry on. */
async function soft<T>(name: string, read: () => Promise<T>, show: (data: T) => ReactNode): Promise<ReactNode> {
  let data: T;
  try {
    data = await read();
  } catch (err) {
    console.error(`home panel "${name}" could not load`, err instanceof Error ? err.name : "error");
    return <p role="status" className="m-0 text-body text-muted">Could not load this part. The rest of Home is fine; it tries again on the next refresh.</p>;
  }
  return show(data);
}

const Empty = ({ children, hint }: { children: ReactNode; hint?: string }) => (
  <>
    <p className="m-0 text-body text-muted">{children}</p>
    {hint ? <p className="m-0 text-small text-faint">{hint}</p> : null}
  </>
);
const topicLink = (id: string, topic: string, lang: string) => (
  <Link href={`/videos/${id}`} lang={lang} className="min-w-0 font-medium underline-offset-2 hover:underline [overflow-wrap:anywhere]">{topic}</Link>
);

function Breakers() {
  return soft("breakers", () => loadBreakers(getPool()), (rows) =>
    rows.length === 0 ? null : (
      <div className="flex flex-col gap-3">
        {rows.map((b) => (
          <div key={b.stage} role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-card bg-pill-warning-bg p-pad text-pill-warning-ink">
            <p className="m-0 min-w-0 text-body">
              &quot;{stageLabel(b.stage)}&quot; is paused after repeated failures{b.until ? ` until ${b.until.toISOString().slice(11, 16)} UTC` : ""}. New videos wait.
            </p>
            <BreakerForm stage={b.stage} />
          </div>
        ))}
      </div>
    ),
  );
}

function Kpis() {
  return soft("kpis", () => loadKpis(getPool()), (k) => (
    <>
      <KpiStrip
        lead={{ label: "In production", value: k.inProduction }}
        figures={[
          { label: "Made in the last 7 days", value: k.madeThisWeek },
          { label: "Published this month", value: k.publishedThisMonth },
        ]}
      />
      <div className="flex min-w-0 flex-col gap-2">
        {k.today.capMicroUsd === null ? <p className="m-0 text-body tabular-nums">{`${spendSentence(k.today, formatUsd)} today`}</p> : <SpendLine spentMicroUsd={k.today.spentMicroUsd} capMicroUsd={k.today.capMicroUsd} />}
        <p className="m-0 text-body tabular-nums text-muted">{`${spendSentence(k.month, formatUsd)} this month`}</p>
      </div>
    </>
  ));
}

function Queue() {
  return soft("queue", () => loadQueue(getPool()), (q) => {
    const gates = q.items.flatMap((i) => (i.kind === "gate" ? [i] : [])); // oldest first already
    if (gates.length === 0) return <Empty hint="Scripts, costs and videos that need your say-so will line up here, oldest first.">Nothing is waiting at a gate.</Empty>;
    return (
      <>
        <p data-testid="waiting-count" className="m-0 text-body text-muted">{`${gates.length} waiting, oldest first.`}</p>
        {gates.slice(0, SHOWN).map((g) => (
          <DecisionRow
            key={`${g.videoId}-${g.gate}`}
            title={g.topic}
            lang={g.language}
            format="short"
            aspect={aspectFor("short")}
            stages={cutStages(g.strip)}
            gateLabel={gateLabel(g.gate)}
            costLabel={g.content.kind === "cost" ? formatUsd(g.content.totalMicroUsd) : "–"}
            ageLabel={agoLabel(g.waitingSince)}
            href="/queue"
            channelName={g.channelId ?? "No channel"}
            channelIndex={0}
          />
        ))}
        <Link href="/queue" className="text-body underline underline-offset-2">{gates.length > SHOWN ? `See all ${gates.length} in the queue` : "Open the queue"}</Link>
      </>
    );
  });
}

function Attention() {
  return soft("attention", () => loadAttention(getPool()), ({ rows, total }) => {
    if (rows.length === 0) return <Empty>Nothing needs attention.</Empty>;
    return (
      <>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.slice(0, SHOWN * 2).map((r) => {
            const t = attentionText(r);
            return (
              <li key={`${r.kind}-${r.videoId}-${r.stage}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  {topicLink(r.videoId, r.topic, "en")}
                  <p className="m-0 text-small text-muted [overflow-wrap:anywhere]">{t.text}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-small text-faint">{agoLabel(r.at)}</span>
                  <Button asChild variant="secondary"><Link href={r.kind === "failed_stage" || r.kind === "upload_failed" ? `/videos/${r.videoId}` : "/queue"} aria-label={`${t.action}: ${r.topic}`}>{t.action}</Link></Button>
                </div>
              </li>
            );
          })}
        </ul>
        {total > SHOWN * 2 ? <p className="m-0 text-small text-faint">{`${total - SHOWN * 2} more not shown.`}</p> : null}
      </>
    );
  });
}

function Active() {
  return soft("active", () => loadActive(getPool()), (rows) =>
    rows.length === 0 ? <Empty>Nothing is running right now.</Empty> : (
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li key={`${r.videoId}-${r.stage}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            {topicLink(r.videoId, r.topic, r.language)}
            <span className="flex items-center gap-2 text-small text-muted"><Pill tone="neutral">Running</Pill>{stageLabel(r.stage)}, started {agoLabel(r.since)} ago</span>
          </li>
        ))}
      </ul>
    ),
  );
}

function UpNext() {
  return soft("next", () => loadUpNext(getPool()), (rows) =>
    rows.length === 0 ? <Empty>Nothing is lined up.</Empty> : (
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li key={r.videoId} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            {topicLink(r.videoId, r.topic, r.language)}
            <span className="text-small text-muted">{stageLabel(r.stage)}, waiting {agoLabel(r.queuedAt)}</span>
          </li>
        ))}
      </ol>
    ),
  );
}

function Recent() {
  return soft("recent", () => loadRecent(getPool()), (rows) =>
    rows.length === 0 ? <Empty>No activity yet.</Empty> : (
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {rows.map((r, i) => (
          <li key={i} className="flex min-w-0 flex-col gap-1">
            <span className="text-body [overflow-wrap:anywhere]">{r.videoId ? <Link href={`/videos/${r.videoId}`} className="underline-offset-2 hover:underline">{r.text}</Link> : r.text}</span>
            <span className="text-small text-faint">{agoLabel(r.at)} ago</span>
          </li>
        ))}
      </ul>
    ),
  );
}
