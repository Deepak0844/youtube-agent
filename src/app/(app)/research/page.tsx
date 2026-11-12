import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { RETENTION_DAYS } from "@/server/core/research";
import { getPool } from "@/server/db/pool";
import { loadResearch, type ResearchView } from "@/server/db/research";
import { AddChannelForm, ChannelPicker, DecideButtons, FindButtons, TrendsButton } from "./research-forms";

export const metadata = { title: "Research" };

// Research. requireOwner() and searchParams are request-time data, so they sit inside <Suspense> (cacheComponents).
// Everything from YouTube, Hacker News and Wikimedia is untrusted text: it is shown through React's escaping and never acted on.
export default function ResearchPage({ searchParams }: PageProps<"/research">) {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

const card = "flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-pad";
const n = (v: number) => v.toLocaleString("en-US");

function TrendList({ title, id, items }: { title: string; id: string; items: ResearchView["trends"]["hackernews"] }) {
  return (
    <div className="min-w-0">
      <h3 id={id} className="text-body font-medium">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-body text-muted">Nothing yet.</p>
      ) : (
        <ul aria-labelledby={id} className="mt-2 flex flex-col gap-2">
          {items.map((t) => (
            <li key={t.url} className="min-w-0 text-body">
              <a href={t.url} target="_blank" rel="noopener noreferrer" className="break-words underline">{t.topic}</a>
              <span className="text-muted"> · {n(t.signal)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function Owned({ searchParams }: { searchParams: PageProps<"/research">["searchParams"] }) {
  await requireOwner();
  const raw = (await searchParams).c;
  const wanted = typeof raw === "string" ? raw : null;
  const db = getPool();
  const first = await loadResearch(db, null);
  const chosen = first.channels.find((c) => c.channelId === wanted) ?? first.channels[0] ?? null;
  const v = chosen ? await loadResearch(db, chosen.channelId) : first;
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Research</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Find channels like yours, watch them, and spot videos that are doing far better than usual. Only public numbers are kept, and they are deleted if not refreshed within {RETENTION_DAYS} days.
          Nothing here is copied; it only gives you angles.
        </p>
        <p className="mt-2 text-body font-medium" data-testid="search-counter">Searches today: {v.searchesToday} of {v.searchLimit}</p>
        <p className="text-small text-muted">The app stops itself at {v.searchStop} a day, because each search costs YouTube quota.</p>
      </header>

      {chosen ? (
        <section aria-labelledby="ch-h" className={card}>
          <h2 id="ch-h" className="text-title font-semibold">Your channel</h2>
          {v.channels.length > 1 ? <ChannelPicker channels={v.channels} selected={chosen.channelId} /> : <p className="text-body">{chosen.title}</p>}
          <FindButtons row={chosen.id} />
        </section>
      ) : (
        <section className={card}>
          <p className="text-body text-muted">Connect and confirm a YouTube channel in Settings, Channels to find competitors. Trend lists below work without one.</p>
        </section>
      )}

      {chosen ? (
        <>
          <section aria-labelledby="sug-h" className={card}>
            <h2 id="sug-h" className="text-title font-semibold">Suggested channels</h2>
            {v.suggestions.length === 0 ? (
              <p className="text-body text-muted">No suggestions yet. Press Find competitors.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {v.suggestions.map((s) => (
                  <li key={s.competitorId} className="flex min-w-0 flex-wrap items-center justify-between gap-3" data-testid="suggestion-row">
                    <span className="min-w-0 text-body">
                      <span className="font-medium">{s.title || s.competitorId}</span> <span className="text-muted">score {s.score}</span>
                      <br />
                      <span className="text-small text-muted">{s.reason}</span>
                    </span>
                    <DecideButtons channel={chosen.channelId} competitor={s.competitorId} title={s.title || s.competitorId} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="watch-h" className={card}>
            <h2 id="watch-h" className="text-title font-semibold">Watching</h2>
            {v.watching.length === 0 ? (
              <p className="text-body text-muted">You are not watching any channel yet.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {v.watching.map((w) => (
                  <li key={w.competitorId} className="min-w-0 text-body" data-testid="watch-row">
                    <span className="font-medium">{w.title || w.competitorId}</span>
                    <span className="text-muted"> · {w.videos} videos · refreshed {w.refreshedAtIst} IST</span>
                  </li>
                ))}
              </ul>
            )}
            <AddChannelForm row={chosen.id} />
          </section>

          <section aria-labelledby="out-h" className={card}>
            <h2 id="out-h" className="text-title font-semibold">Outliers</h2>
            <p className="text-small text-muted">Videos from watched channels with at least 3 times that channel&apos;s median views, published in the last 14 days.</p>
            {v.outliers.length === 0 ? (
              <p className="text-body text-muted">No outliers right now.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-body">
                  <thead>
                    <tr className="text-small text-muted">
                      <th className="py-2 pr-4 font-medium">Video</th>
                      <th className="py-2 pr-4 font-medium">Channel</th>
                      <th className="py-2 pr-4 font-medium">Views</th>
                      <th className="py-2 pr-4 font-medium">Times median</th>
                      <th className="py-2 font-medium">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.outliers.map((o) => (
                      <tr key={o.videoId} data-testid="outlier-row">
                        <td className="max-w-xs py-2 pr-4 break-words"><a href={`https://youtu.be/${o.videoId}`} target="_blank" rel="noopener noreferrer" className="underline">{o.title || o.videoId}</a></td>
                        <td className="py-2 pr-4">{o.channel}</td>
                        <td className="py-2 pr-4">{n(o.views)}</td>
                        <td className="py-2 pr-4">{o.xMedian}x</td>
                        <td className="py-2">{o.ageDays} day{o.ageDays === 1 ? "" : "s"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      ) : null}

      <section aria-labelledby="trend-h" className={card}>
        <h2 id="trend-h" className="text-title font-semibold">Trends</h2>
        <p className="text-small text-muted">From Hacker News and the most-read pages on Wikipedia (Wikimedia). Just topics to think about; the text is shown as-is and never acted on.</p>
        <TrendsButton />
        <div className="grid min-w-0 gap-6 md:grid-cols-2">
          <TrendList title="Hacker News" id="hn-h" items={v.trends.hackernews} />
          <TrendList title="Wikipedia most read" id="wiki-h" items={v.trends.wikimedia} />
        </div>
      </section>
    </div>
  );
}
