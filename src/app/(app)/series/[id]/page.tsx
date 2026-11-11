import Link from "next/link";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { LANGUAGE_WORDS } from "@/server/core/videos-view";
import { getPool } from "@/server/db/pool";
import { getSeries } from "@/server/db/series";
import { loadInrRate } from "@/server/db/system-settings";
import { CostLine, PartCard, PlanPartsForm } from "../series-parts";

export const metadata = { title: "Series" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// One series: its parts with each part's stage row, cost against the cap, and the buttons. requireOwner() runs inside <Suspense>.
export default function SeriesPage({ params }: PageProps<"/series/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned params={params} />
    </Suspense>
  );
}

async function Owned({ params }: { params: PageProps<"/series/[id]">["params"] }) {
  await requireOwner();
  const { id } = await params;
  const db = getPool();
  const [s, rate] = await Promise.all([UUID.test(id) ? getSeries(db, id) : Promise.resolve(null), loadInrRate(db)]);
  // Deliberately a page with its own <h1>, not notFound(): the session-required spec needs a heading on every page to prove denied responses carry no content.
  if (!s)
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-page-title font-semibold tracking-tight">Series not found</h1>
        <Link href="/series" className="text-small text-muted underline">
          All series
        </Link>
      </div>
    );
  const planned = s.parts.filter((p) => p.status === "planned").map((p) => p.partNo);
  const shown = s.parts.filter((p) => p.status !== "dropped");
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header className="flex flex-col gap-2">
        <h1 className="break-words text-page-title font-semibold tracking-tight">{s.title}</h1>
        <p className="m-0 text-small text-muted">{`${LANGUAGE_WORDS[s.language]} · ${s.channelTitle ? `Channel: ${s.channelTitle}` : "No channel"} · ${s.formats === "mixed" ? "Mixed formats" : s.formats === "long" ? "Long videos" : "Shorts"}`}</p>
        {s.premise ? <p className="m-0 max-w-prose break-words text-body text-muted">{s.premise}</p> : null}
        <CostLine spentMicroUsd={s.spentMicroUsd} capMicroUsd={s.capMicroUsd} state={s.cap.state} pct={s.cap.pct} rate={rate} />
      </header>
      <section aria-labelledby="parts-h" className="flex flex-col gap-3">
        <h2 id="parts-h" className="text-title font-semibold">Parts</h2>
        {shown.length === 0 ? (
          <p className="text-body text-muted">No parts yet. Add the episode list below.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {shown.map((p) => (
              <li key={p.partNo} className="min-w-0 rounded-card border border-border bg-surface p-pad">
                <PartCard
                  seriesId={s.id}
                  part={{ ...p, canUp: planned.length > 0 && planned[0] !== p.partNo, canDown: planned.length > 0 && planned[planned.length - 1] !== p.partNo }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <PlanPartsForm seriesId={s.id} />
    </div>
  );
}
