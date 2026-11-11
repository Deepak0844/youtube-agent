import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { formatIst } from "@/server/core/display-format";
import { getPool } from "@/server/db/pool";
import { recentRuns } from "@/server/db/scheduler";
import { loadScheduler } from "@/server/db/system-settings";
import { ScheduleForm } from "./schedule-form";

export const metadata = { title: "Schedule" };

// Scheduler settings. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function SchedulePage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [settings, runs] = await Promise.all([loadScheduler(db), recentRuns(db, 10)]);
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Schedule</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          What the app does by itself, and when. All hours are India time (IST). A job that fails is not tried again the same day; you get a notice instead.
        </p>
      </header>
      <ScheduleForm s={settings} />
      <section aria-labelledby="runs-h" className="rounded-card bg-surface p-pad">
        <h2 id="runs-h" className="text-title font-semibold">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-body text-muted">Nothing has run yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {runs.map((r) => (
              <li key={`${r.job}-${r.runKey}`} className="min-w-0 text-body">
                <span className="font-medium">{r.job}</span> · {formatIst(r.startedAt)} · {r.status}
                {r.message ? <span className="text-muted"> · {r.message}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
