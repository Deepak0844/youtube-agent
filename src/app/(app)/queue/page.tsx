import Link from "next/link";
import { ChevronLeft, Inbox } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { dryRunAllowed } from "@/lib/dry-run";
import { requireOwner } from "@/lib/auth/require-owner";
import { jobCheckers } from "./job-checkers";
import { getPool } from "@/server/db/pool";
import { dryRunRefusal } from "@/worker/stages/guard";
import { loadInrRate } from "@/server/db/system-settings";
import { loadQueue } from "@/server/db/queue-data";
import { listUploads } from "@/server/db/upload-actions";
import { Pill } from "@/ui/primitives/pill";
import { cn, focusRing } from "@/ui/lib/cn";
import { EmptyState } from "@/ui/states/empty-state";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { Pagination } from "@/ui/states/pagination";
import { attentionText, gateLabel, stageLabel } from "@/server/core/home-view";
import { clampPage, pageHref, parsePage } from "@/server/core/paging";
import { parseQueueTab, pickItem } from "@/server/core/queue-inbox";
import { loadActive, loadAttention } from "@/server/db/home-data";
import { DecisionCard } from "./decision-card";
import { BreakerForm, DryRunForm, RequeueForm } from "./forms";
import { GateCard, ageLabel } from "./gate-card";
import { LiveFeed } from "./live-feed";
import { UploadsSection } from "./uploads-section";

export const metadata = { title: "Queue" };

// The decision queue (Doc 4 /queue), as an inbox (UI redesign spec §4.3): what waits on the owner on the left, oldest
// first; the selected item on the right with its gate buttons. Selection and tab live in the URL. Reads the session and
// live rows, so it sits inside <Suspense>. Each card renders the hash and content versions it was built from and posts
// them back; the actions compare them with the live state.
export default function Queue({ searchParams }: PageProps<"/queue">) {
  return (
    <Suspense fallback={<PageSkeleton variant="inbox" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: unknown) => (typeof v === "string" ? v : undefined);

async function Owned({ searchParams }: Pick<PageProps<"/queue">, "searchParams">) {
  await requireOwner();
  const sp = await searchParams;
  const tab = parseQueueTab(sp.tab);
  const q = await loadQueue(getPool(), new Set(Object.keys(jobCheckers())));
  // The starter shows only when the opt-in is set AND the database guard agrees (throwaway database, no provider key).
  const dryRun = dryRunAllowed() && (await dryRunRefusal(getPool(), process.env).catch(() => "unchecked")) === null;
  const uploads = await listUploads(getPool());
  const rate = await loadInrRate(getPool());
  const running = await loadActive(getPool(), 100).catch(() => []);
  const failed = (await loadAttention(getPool(), 100).catch(() => ({ rows: [] }))).rows.filter((r) => r.kind === "failed_stage" || r.kind === "upload_failed");
  const waiting = q.items.length;
  const wanted = one(sp.item);
  const selected = tab === "needs" ? pickItem(q.items, wanted) : null;
  const tabHref = (t: string) => (t === "needs" ? "/queue" : `/queue?tab=${t}`);
  const listLen = tab === "needs" ? q.items.length : tab === "running" ? running.length : failed.length;
  const page = clampPage(parsePage(sp), listLen);
  const params = { tab: tab === "needs" ? undefined : tab, page: one(sp.page), size: one(sp.size) };
  const shown = <T,>(rows: T[]) => rows.slice(page.offset, page.offset + page.limit);
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight">Queue</h1>
          <p data-testid="queue-count" className="m-0 text-body text-muted">{waiting === 0 ? "Nothing is waiting on you." : `${waiting} waiting on you, oldest first.`}</p>
        </div>
        {dryRun ? <DryRunForm /> : null}
      </div>
      <LiveFeed />

      {q.breakers.length > 0 ? (
        <section aria-labelledby="paused-h" className="flex flex-col gap-3 rounded-card bg-pill-warning-bg p-pad text-pill-warning-ink">
          <h2 id="paused-h" className="text-title font-semibold">Paused steps</h2>
          {q.breakers.map((b) => (
            <div key={b.stage} className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 text-body">The {b.stage} step is paused after repeated failures{b.until ? ` until ${new Date(b.until).toISOString().slice(11, 16)} UTC` : ""}. New videos wait.</p>
              <BreakerForm stage={b.stage} />
            </div>
          ))}
        </section>
      ) : null}

      {q.stranded.length > 0 ? (
        <section aria-labelledby="stranded-h" className="flex flex-col gap-3 rounded-card border border-border bg-surface p-pad">
          <h2 id="stranded-h" className="text-title font-semibold">Approved, not yet uploading</h2>
          <p className="m-0 text-body text-muted">These were approved to publish but the uploader has not picked them up. Sending again is safe: an upload still happens only once.</p>
          {q.stranded.map((u) => (
            <div key={u.uploadId} className="flex flex-wrap items-center justify-between gap-3">
              <p className="m-0 min-w-0 text-body [overflow-wrap:anywhere]">{u.topic} <Pill tone="neutral">approved {ageLabel(u.approvedAt)} ago</Pill></p>
              <RequeueForm uploadId={u.uploadId} topic={u.topic} />
            </div>
          ))}
        </section>
      ) : null}

      <div className="grid min-w-0 gap-layout md:grid-cols-[310px_minmax(0,1fr)] md:items-start">
        <section aria-label="Waiting on you" className={cn("flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-surface", wanted && tab === "needs" && "max-md:hidden")}>
          <nav aria-label="Queue tabs" className="flex gap-1 border-b border-border p-2">
            {([["needs", "Needs you", waiting], ["running", "Running", running.length], ["failed", "Failed", failed.length]] as const).map(([t, label, n]) => (
              <Link key={t} href={tabHref(t)} aria-current={tab === t ? "page" : undefined} className={cn("flex min-h-11 items-center gap-1.5 rounded-control px-2.5 text-small sm:min-h-8", tab === t ? "bg-raised font-medium text-text" : "text-muted hover:text-text", focusRing)}>
                {label}
                <span className="tabular-nums text-faint">{n}</span>
              </Link>
            ))}
          </nav>
          {tab === "needs" && (q.items.length === 0 ? (
            <EmptyState icon={Inbox} title="Nothing is waiting on you" body="Scripts, costs, videos and publishes that need your say-so will line up here, oldest first." className="m-3 border-0" />
          ) : (
            <ul className="flex flex-col">
              {shown(q.items).map((item) => (
                <ListRow
                  key={`${item.videoId}-${item.kind}`}
                  href={`/queue?item=${encodeURIComponent(item.videoId)}`}
                  on={selected?.videoId === item.videoId}
                  topic={item.topic}
                  lang={item.language}
                  meta={`${item.format === "long" ? "Long" : "Short"}${item.kind === "gate" ? ` · ${ageLabel(item.waitingSince)}` : ""}`}
                  pill={item.kind === "gate" ? <Pill tone={item.gate === "cost" ? "info" : "warning"}>{gateLabel(item.gate)}</Pill> : <Pill tone="negative">Needs your decision</Pill>}
                />
              ))}
            </ul>
          ))}
          {tab === "running" && (running.length === 0 ? (
            <EmptyState icon={Inbox} title="Nothing is running right now" className="m-3 border-0" />
          ) : (
            <ul className="flex flex-col">
              {shown(running).map((r) => (
                <ListRow key={`${r.videoId}-${r.stage}`} href={`/videos/${r.videoId}`} topic={r.topic} lang={r.language} meta={stageLabel(r.stage)} pill={<Pill tone="neutral">Running</Pill>} />
              ))}
            </ul>
          ))}
          {tab === "failed" && (failed.length === 0 ? (
            <EmptyState icon={Inbox} title="Nothing has failed" className="m-3 border-0" />
          ) : (
            <ul className="flex flex-col">
              {shown(failed).map((r) => (
                <ListRow key={`${r.videoId}-${r.kind}-${r.stage}`} href={`/videos/${r.videoId}`} topic={r.topic} lang="en" meta={attentionText(r).text} pill={<Pill tone="negative">Failed</Pill>} />
              ))}
            </ul>
          ))}
          {listLen > 25 && (
            <div className="border-t border-border p-3">
              <Pagination page={page.page} size={page.size} total={listLen} hrefFor={(c) => pageHref("/queue", params, c)} />
            </div>
          )}
        </section>

        <section aria-label="Selected item" className={cn("min-w-0", !(wanted && tab === "needs") && "max-md:hidden")}>
          {wanted && tab === "needs" ? (
            <Link href="/queue" className="mb-3 inline-flex items-center gap-1 text-body text-muted hover:text-text md:hidden">
              <ChevronLeft size={14} aria-hidden /> Back to list
            </Link>
          ) : null}
          {selected === null ? (
            tab === "needs" && waiting === 0 && !wanted ? null : (
              <EmptyState
                icon={Inbox}
                title={tab !== "needs" ? "Pick a video" : waiting === 0 ? "Nothing else is waiting on you" : "This one is done"}
                body={tab !== "needs" ? "Running and failed items open on their video page." : waiting === 0 ? "New scripts, costs and publishes will line up in the queue." : "Pick another item from the list."}
              />
            )
          ) : selected.kind === "gate" ? (
            <GateCard key={`${selected.videoId}-${selected.gate}`} item={selected} index={0} rate={rate} />
          ) : (
            <DecisionCard key={`${selected.videoId}-decision`} item={selected} />
          )}
        </section>
      </div>

      <UploadsSection rows={uploads} />
    </div>
  );
}

function ListRow({ href, on, topic, lang, meta, pill }: { href: string; on?: boolean; topic: string; lang: string; meta: string; pill: ReactNode }) {
  return (
    <li className="border-b border-border last:border-0">
      <Link href={href} aria-current={on ? "true" : undefined} className={cn("flex min-w-0 flex-col gap-1.5 px-3 py-3 hover:bg-raised", on && "bg-raised shadow-[inset_2px_0_0_var(--text)]", focusRing)}>
        <span lang={lang} className="min-w-0 font-medium text-text [overflow-wrap:anywhere]">{topic}</span>
        <span className="text-small text-faint">{meta}</span>
        <span>{pill}</span>
      </Link>
    </li>
  );
}
