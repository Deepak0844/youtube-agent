import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { agoLabel, attentionText, gateLabel, spendSentence, stageLabel } from "@/server/core/home-view";
import { setupIncomplete } from "@/server/core/onboarding";
import { loadOnboardingFacts } from "@/server/db/onboarding";
import { getPool } from "@/server/db/pool";
import { loadActive, loadAttention, loadBreakers, loadKpis, loadRecent, loadUpNext } from "@/server/db/home-data";
import { loadInrRate } from "@/server/db/system-settings";
import { loadQueue } from "@/server/db/queue-data";
import { DecisionRow } from "@/ui/domain/decision-row";
import { SpendLine, formatUsd } from "@/ui/domain/spend-line";
import { cutStages } from "@/ui/domain/queue-strip";
import { aspectFor } from "@/ui/domain/stages";
import { Button } from "@/ui/primitives/button";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { TimeAgo } from "@/ui/states/time-ago";
import { BreakerForm } from "./queue/forms";
import { LiveFeed } from "./queue/live-feed";

export const metadata = { title: "Home" };

// Home (Doc 4 section 2, "/"): every panel reads on its own inside its own <Suspense>, and a panel that cannot load says so
// without taking the others down. Nothing here acts except the existing "Release" button on a paused step.
const SHOWN = 5;

export default function Home() {
  return (
    <Suspense fallback={<PageSkeleton variant="list" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-page-title font-semibold tracking-tight">Home</h1>
          <p className="text-body text-muted">What needs you, what is running, and what it costs.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary"><Link href="/videos/new?format=long">New long video</Link></Button>
          <Button asChild><Link href="/videos/new?format=short">New short</Link></Button>
        </div>
      </div>
      <Suspense fallback={null}><FirstRun /></Suspense>
      <LiveFeed />
      <Panel id="breakers" title="Paused steps" bare><Breakers /></Panel>
      <Panel id="kpis" title="This month" bare><Kpis /></Panel>
      <div className="grid min-w-0 gap-layout xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-layout">
          <Panel id="queue" title="Needs you" flush action={<Link href="/queue" className="text-small text-muted hover:text-text">Open queue →</Link>}><Queue /></Panel>
          <Panel id="attention" title="Needs attention"><Attention /></Panel>
          <Panel id="active" title="Running now"><Active /></Panel>
          <Panel id="next" title="Up next"><UpNext /></Panel>
        </div>
        <aside aria-label="Recent activity" className="flex min-w-0 flex-col gap-layout">
          <Panel id="recent" title="Recent activity"><Recent /></Panel>
        </aside>
      </div>
    </div>
  );
}

/** First-run link: shown while any setup step is open. A failed read just hides it. */
async function FirstRun() {
  let open = false;
  try {
    open = setupIncomplete(await loadOnboardingFacts(getPool()));
  } catch {
    return null;
  }
  if (!open) return null;
  return (
    <p data-testid="first-run" className="m-0 flex flex-wrap items-center gap-3 rounded-card bg-pill-warning-bg p-pad text-body text-pill-warning-ink">
      Setup is not finished yet.
      <Link href="/onboarding" className="font-medium underline underline-offset-2">Continue setup</Link>
    </p>
  );
}

/** One Home panel: a bordered card with a title row, or (`bare`) just its content. `flush` = rows run edge to edge. */
function Panel({ id, title, bare, flush, action, children }: { id: string; title: string; bare?: boolean; flush?: boolean; action?: ReactNode; children: ReactNode }) {
  if (bare)
    return (
      <section aria-labelledby={`${id}-h`} data-testid={`panel-${id}`} className="flex min-w-0 flex-col gap-3">
        <h2 id={`${id}-h`} className="sr-only">{title}</h2>
        <Suspense fallback={<Skeleton className="h-20" />}>{children}</Suspense>
      </section>
    );
  return (
    <section aria-labelledby={`${id}-h`} data-testid={`panel-${id}`} className="flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-pad py-3">
        <h2 id={`${id}-h`} className="text-section font-semibold">{title}</h2>
        {action}
      </div>
      <div className={flush ? "flex min-w-0 flex-col" : "flex min-w-0 flex-col gap-3 p-pad"}>
        <Suspense fallback={<Skeleton className="m-pad h-20" />}>{children}</Suspense>
      </div>
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

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface p-pad">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="m-0 flex min-w-0 flex-col gap-2">{children}</dd>
    </div>
  );
}
const figure = (n: number) => <span className="text-kpi font-semibold leading-none tracking-tight tabular-nums">{n}</span>;

function Kpis() {
  return soft(
    "kpis",
    async () => ({ k: await loadKpis(getPool()), rate: await loadInrRate(getPool()), waiting: (await loadQueue(getPool())).items.filter((i) => i.kind === "gate").length }),
    ({ k, rate, waiting }) => (
      <dl className="m-0 grid min-w-0 grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-px overflow-hidden rounded-card border border-border bg-border">
        <Stat label="Waiting on you">{figure(waiting)}</Stat>
        <Stat label="In production">{figure(k.inProduction)}</Stat>
        <Stat label="Made in the last 7 days">{figure(k.madeThisWeek)}</Stat>
        <Stat label="Published this month">{figure(k.publishedThisMonth)}</Stat>
        <Stat label="Spend">
          {k.today.capMicroUsd === null ? <span className="text-body tabular-nums">{`${spendSentence(k.today, (m) => formatUsd(m, rate))} today`}</span> : <SpendLine spentMicroUsd={k.today.spentMicroUsd} capMicroUsd={k.today.capMicroUsd} rate={rate} />}
          <span className="text-small tabular-nums text-muted">{`${spendSentence(k.month, (m) => formatUsd(m, rate))} this month`}</span>
        </Stat>
      </dl>
    ),
  );
}

function Queue() {
  return soft("queue", async () => ({ q: await loadQueue(getPool()), rate: await loadInrRate(getPool()) }), ({ q, rate }) => {
    const gates = q.items.flatMap((i) => (i.kind === "gate" ? [i] : [])); // oldest first already
    if (gates.length === 0) return <div className="flex flex-col gap-1 p-pad"><Empty hint="Scripts, costs and videos that need your say-so will line up here, oldest first.">Nothing is waiting at a gate.</Empty></div>;
    return (
      <>
        <p data-testid="waiting-count" className="m-0 px-pad pt-3 text-small text-muted">{`${gates.length} waiting, oldest first.`}</p>
        {gates.slice(0, SHOWN).map((g) => (
          <DecisionRow
            key={`${g.videoId}-${g.gate}`}
            title={g.topic}
            lang={g.language}
            format={g.format}
            aspect={aspectFor(g.format)}
            stages={cutStages(g.strip, g.format)}
            gateLabel={gateLabel(g.gate)}
            costLabel={g.content.kind === "cost" ? formatUsd(g.content.totalMicroUsd, rate) : "–"}
            ageLabel={agoLabel(g.waitingSince)}
            href="/queue"
            channelName={g.channelId ?? "No channel"}
            channelIndex={0}
          />
        ))}
        {gates.length > SHOWN && <Link href="/queue" className="px-pad py-3 text-body underline underline-offset-2">{`See all ${gates.length} in the queue`}</Link>}
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
            <span className="flex items-center gap-2 text-small text-muted"><Pill tone="neutral">Running</Pill>{stageLabel(r.stage)}, started <TimeAgo at={new Date(r.since)} live /></span>
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
            <span className="text-small text-muted">{stageLabel(r.stage)}, queued <TimeAgo at={new Date(r.queuedAt)} /></span>
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
            <span className="text-small text-faint"><TimeAgo at={new Date(r.at)} live /></span>
          </li>
        ))}
      </ul>
    ),
  );
}
