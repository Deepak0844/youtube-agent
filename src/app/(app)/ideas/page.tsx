import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { listIdeas } from "@/server/db/ideas";
import { getPool } from "@/server/db/pool";
import { AddIdeaForm, IdeaCard } from "./idea-parts";
import { ResearchNowForm } from "./research-now";

// The idea backlog. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function IdeasPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const ideas = await listIdeas(getPool());
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Ideas</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Topics to make next. Draft now starts a normal video that stops at its first approval step: nothing is approved or uploaded for you. Ideas too like an old idea or an existing video are refused.
        </p>
      </header>
      <ResearchNowForm />
      <AddIdeaForm />
      <section aria-labelledby="backlog-h" className="flex flex-col gap-3">
        <h2 id="backlog-h" className="text-title font-semibold">Backlog</h2>
        {ideas.length === 0 ? (
          <p className="text-body text-muted">No ideas yet. Add one above.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {ideas.map((i) => (
              <li key={i.id} className="min-w-0 rounded-card bg-surface p-pad">
                <IdeaCard idea={i} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
