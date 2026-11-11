import { Suspense } from "react";
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
          <p className="text-body text-muted">No ideas yet. Add one above.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {ideas.map((i) => (
              <li key={i.id} className="min-w-0 rounded-card border border-border bg-surface p-pad">
                <IdeaCard idea={i} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
