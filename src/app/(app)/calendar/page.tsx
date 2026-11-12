import Link from "next/link";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { formatIst, formatMoney } from "@/server/core/display-format";
import { nextDraftWindow, parseRunCounts } from "@/server/core/calendar";
import { DRAFT_WINDOW_HOURS } from "@/server/core/scheduler";
import { loadCalendar } from "@/server/db/calendar-data";
import { getPool } from "@/server/db/pool";
import { UploadList } from "./calendar-parts";

export const metadata = { title: "Calendar" };

// Calendar: read only. Settings change on /settings/schedule. requireOwner() reads the cookie, so it runs inside <Suspense> (cacheComponents).
export default function CalendarPage() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

const card = "flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-pad";
const link = "text-body font-medium underline underline-offset-2";

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col" data-testid={testId}>
      <dt className="text-small text-muted">{label}</dt>
      <dd className="m-0 font-semibold">{value}</dd>
    </div>
  );
}

async function Owned() {
  await requireOwner();
  const now = new Date();
  const d = await loadCalendar(getPool());
  const s = d.settings;
  const win = nextDraftWindow(now, s.hour);
  const counts = parseRunCounts(d.lastDrafting?.message ?? null);
  const money = (micro: number) => formatMoney(micro, d.rate);
  return (
    <div className="grid min-w-0 gap-layout xl:grid-cols-2 xl:items-start">
      <header className="xl:col-span-2">
        <h1 className="text-page-title font-semibold tracking-tight">Calendar</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          What is planned and what ran. This page only shows things; to change a setting go to{" "}
          <Link href="/settings/schedule" className={link}>Settings, Schedule</Link>. All times are India time (IST).
        </p>
      </header>

      <section aria-labelledby="draft-h" className={card}>
        <h2 id="draft-h" className="text-title font-semibold">Overnight drafting</h2>
        <p className="m-0 text-body" data-testid="drafting-state">
          {s.enabled ? "On" : "Off"} · starts at {String(s.hour).padStart(2, "0")}:00 IST · {s.max_drafts} draft{s.max_drafts === 1 ? "" : "s"} per night
        </p>
        <p className="m-0 text-body" data-testid="next-window">
          {win.inWindow ? "Window open now, started" : "Next window starts"} {formatIst(win.start)} (runs {DRAFT_WINDOW_HOURS} hours)
          {s.enabled ? "" : ". Nothing will start while drafting is off"}
        </p>
        <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat testId="count-started" label="Last run: started" value={counts ? String(counts.started) : "—"} />
          <Stat testId="count-skipped" label="Last run: skipped" value={counts ? String(counts.skipped) : "—"} />
          <Stat testId="count-waiting" label="Waiting for you" value={String(d.waiting)} />
          <Stat testId="money-left" label="Money left" value={d.budgetLeftMicro === null ? "No limit" : money(Math.max(0, d.budgetLeftMicro))} />
        </dl>
        <p className="m-0 text-small text-muted">
          {d.lastDrafting ? `Last drafting run: ${formatIst(d.lastDrafting.startedAt)}, ${d.lastDrafting.status}.` : "Drafting has not run yet."} Money left is the smaller of today and this month.
        </p>
      </section>

      <section aria-labelledby="runs-h" className={card}>
        <h2 id="runs-h" className="text-title font-semibold">Recent scheduler activity</h2>
        {d.runs.length === 0 ? (
          <p className="m-0 text-body text-muted">Nothing has run yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {d.runs.map((r) => (
              <li key={`${r.job}-${r.runKey}`} className="min-w-0 text-body [overflow-wrap:anywhere]" data-testid="run-row">
                <span className="font-medium">{r.job}</span> · {formatIst(r.startedAt)} · {r.status}
                {r.message ? <span className="text-muted"> · {r.message}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ideas-h" className={card}>
        <h2 id="ideas-h" className="text-title font-semibold">Idea backlog</h2>
        {d.ideas.length === 0 ? (
          <p className="m-0 text-body text-muted">No proposed ideas.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {d.ideas.map((i) => (
              <li key={i.id} className="min-w-0 text-body [overflow-wrap:anywhere]" data-testid="idea-row">
                <span className="font-medium">{i.topic}</span> <span className="text-muted">· score {i.score}</span>
              </li>
            ))}
          </ul>
        )}
        <Link href="/ideas" className={link}>Open all ideas</Link>
      </section>

      <section aria-labelledby="queue-h" className={card}>
        <h2 id="queue-h" className="text-title font-semibold">Upload queue</h2>
        <UploadList rows={d.queue} empty="Nothing is waiting to upload." />
      </section>

      <section aria-labelledby="up-h" className={card}>
        <h2 id="up-h" className="text-title font-semibold">Uploaded</h2>
        <UploadList rows={d.uploaded} empty="Nothing uploaded yet." />
      </section>
    </div>
  );
}
