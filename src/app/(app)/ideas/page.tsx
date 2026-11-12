import { Suspense } from "react";
import { Lightbulb } from "lucide-react";
import { clampPage, pageHref, parsePage } from "@/server/core/paging";
import { EmptyState } from "@/ui/states/empty-state";
import { Pagination } from "@/ui/states/pagination";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { connectedChannelOptions, listIdeas } from "@/server/db/ideas";
import { getPool } from "@/server/db/pool";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { AddIdeaForm, IdeaCard } from "./idea-parts";
import { ResearchNowForm } from "./research-now";

export const metadata = { title: "Ideas" };

// The idea backlog. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function IdeasPage({ searchParams }: PageProps<"/ideas">) {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

async function Owned({ searchParams }: { searchParams: PageProps<"/ideas">["searchParams"] }) {
  await requireOwner();
  const sp = await searchParams;
  const db = getPool();
  const channels = await connectedChannelOptions(db);
  const pick = typeof sp.channel === "string" ? sp.channel : "";
  // "none" = ideas with no channel; a channel id = that channel's ideas; anything else shows all.
  const all = await listIdeas(db);
  const known = pick === "none" || channels.some((c) => c.channelId === pick);
  const ideas = pick === "none" ? all.filter((i) => !i.channelId) : known ? all.filter((i) => i.channelId === pick) : all;
  const shown = known ? pick : "";
  const req = clampPage(parsePage(sp), ideas.length);
  const pageRows = ideas.slice(req.offset, req.offset + req.limit);
  const params = { channel: shown || undefined, page: typeof sp.page === "string" ? sp.page : undefined, size: typeof sp.size === "string" ? sp.size : undefined };
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Ideas</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Topics to make next. Draft now starts a normal video that stops at its first approval step: nothing is approved or uploaded for you. Ideas too like an old idea or an existing video are refused.
        </p>
      </header>
      <ResearchNowForm channels={channels} />
      <AddIdeaForm channels={channels} />
      <section aria-labelledby="backlog-h" className="flex flex-col gap-3">
        <h2 id="backlog-h" className="text-title font-semibold">Backlog</h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="filter-channel">Show channel</Label>
            <select id="filter-channel" name="channel" defaultValue={shown} className="min-h-11 rounded-control border border-control bg-surface px-4 text-body text-text">
              <option value="">All channels</option>
              <option value="none">No channel</option>
              {channels.map((c) => (
                <option key={c.channelId} value={c.channelId}>{c.title || c.channelId}</option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="secondary">Filter</Button>
        </form>
        {ideas.length === 0 ? (
          <EmptyState icon={Lightbulb} title="No ideas yet" body="Add one above, or let research suggest some." filtered={shown ? { clearHref: "/ideas" } : undefined} />
        ) : (
          <>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(360px,100%),1fr))] gap-gap p-0">
              {pageRows.map((i) => (
                <li key={i.id} className="min-w-0 rounded-card border border-border bg-surface p-pad">
                  <IdeaCard idea={i} />
                </li>
              ))}
            </ul>
            {ideas.length > 25 ? <Pagination page={req.page} size={req.size} total={ideas.length} hrefFor={(c) => pageHref("/ideas", params, c)} /> : null}
          </>
        )}
      </section>
    </div>
  );
}
