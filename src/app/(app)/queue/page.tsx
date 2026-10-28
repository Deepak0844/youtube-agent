import { Suspense } from "react";
import { dryRunAllowed } from "@/lib/dry-run";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { dryRunRefusal } from "@/worker/stages/guard";
import { loadQueue } from "@/server/db/queue-data";
import { Pill } from "@/ui/primitives/pill";
import { DecisionCard } from "./decision-card";
import { BreakerForm, DryRunForm, RequeueForm } from "./forms";
import { GateCard, ageLabel } from "./gate-card";
import { LiveFeed } from "./live-feed";

// The decision queue (Doc 4 /queue): everything that waits on the owner, oldest first. Reads the session and live rows, so
// it sits inside <Suspense> with a static frame. Each card renders the hash and content versions it was built from and posts
// them back; the actions compare them with the live state.
export default function Queue() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const q = await loadQueue(getPool());
  // The starter shows only when the opt-in is set AND the database guard agrees (throwaway database, no provider key).
  const dryRun = dryRunAllowed() && (await dryRunRefusal(getPool(), process.env).catch(() => "unchecked")) === null;
  const waiting = q.items.length;
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
        <section aria-labelledby="stranded-h" className="flex flex-col gap-3 rounded-card bg-surface p-pad">
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

      <section aria-label="Waiting on you" className="flex min-w-0 flex-col gap-layout">
        {q.items.length === 0 ? (
          <div className="rounded-card bg-surface p-pad">
            <p className="m-0 text-body text-muted">Nothing is waiting on you.</p>
            <p className="mt-1 mb-0 text-small text-faint">Scripts, costs, videos and publishes that need your say-so will line up here, oldest first.</p>
          </div>
        ) : (
          q.items.map((item, i) => (item.kind === "gate" ? <GateCard key={`${item.videoId}-${item.gate}`} item={item} index={i} /> : <DecisionCard key={`${item.videoId}-decision`} item={item} />))
        )}
      </section>
    </div>
  );
}
