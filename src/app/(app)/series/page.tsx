import Link from "next/link";
import { EmptyState } from "@/ui/states/empty-state";
import { ListVideo } from "lucide-react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { LANGUAGE_WORDS } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { listSeries } from "@/server/db/series";
import { loadInrRate } from "@/server/db/system-settings";
import { Button } from "@/ui/primitives/button";
import { CostLine } from "./series-parts";

export const metadata = { title: "Series" };

// Series list. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function SeriesPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [series, rate] = await Promise.all([listSeries(db), loadInrRate(db)]);
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-page-title font-semibold tracking-tight">Series</h1>
          <p className="mt-2 max-w-prose text-body text-muted">Plan a run of episodes, then start them one at a time. Starting a part makes a normal video draft that stops at its first approval step.</p>
        </div>
        <Button asChild>
          <Link href="/series/new">New series</Link>
        </Button>
      </header>
      {series.length === 0 ? (
        <EmptyState icon={ListVideo} title="No series yet" body="A series plans a run of episodes that share one channel, language and look." action={<Button asChild><Link href="/series/new">New series</Link></Button>} />
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(360px,100%),1fr))] gap-3 p-0">
          {series.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-surface p-pad">
              <Link href={`/series/${s.id}`} className="min-w-0 break-words text-title font-semibold underline-offset-4 hover:underline">{s.title}</Link>
              <p className="m-0 text-small text-muted">
                {`${s.partsStarted} of ${s.partsPlanned} parts started · ${LANGUAGE_WORDS[s.language]} · ${s.channelTitle ? `Channel: ${s.channelTitle}` : "No channel"}`}
              </p>
              <CostLine spentMicroUsd={s.spentMicroUsd} capMicroUsd={s.capMicroUsd} state={s.cap.state} pct={s.cap.pct} rate={rate} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
