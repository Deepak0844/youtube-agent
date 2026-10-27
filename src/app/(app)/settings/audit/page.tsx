import Link from "next/link";
import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { AUDIT_EVENTS, isAuditEvent } from "@/server/core/audit-events";
import {
  AUDIT_FILTERS,
  auditHref,
  describeDetail,
  filterPrefix,
  parseAuditQuery,
  relativeTime,
  truncateText,
  utcStamp,
} from "@/server/core/audit-view";
import { listAudit, type AuditRow } from "@/server/db/audit";
import { getPool } from "@/server/db/pool";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { cn, focusRing } from "@/ui/lib/cn";
import { Pill } from "@/ui/primitives/pill";
import { Skeleton } from "@/ui/primitives/skeleton";

const PAGE_SIZE = 50;

// Read-only. searchParams and the session are request-time data, so everything sits inside <Suspense> (cacheComponents).
// Every value on this page is plain text through React's escaping: there is no HTML sink anywhere in this file.
export default function AuditPage({ searchParams }: PageProps<"/settings/audit">) {
  return (
    <Suspense fallback={<Frame />}>
      <Owned searchParams={searchParams} />
    </Suspense>
  );
}

function Frame() {
  return (
    <div aria-hidden className="flex min-w-0 flex-col gap-layout">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-11 w-full max-w-xl" />
      <Skeleton className="h-96 w-full rounded-card" />
    </div>
  );
}

async function Owned({ searchParams }: { searchParams: PageProps<"/settings/audit">["searchParams"] }) {
  await requireOwner();
  const query = parseAuditQuery(await searchParams);
  const { rows, next } = await listAudit(getPool(), {
    limit: PAGE_SIZE,
    eventPrefix: filterPrefix(query.filter),
    ...(query.before ? { before: query.before } : {}),
  });
  const now = new Date();
  const days = groupByDay(rows);
  const filterLabel = AUDIT_FILTERS.find((f) => f.id === query.filter)?.label;

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Audit log</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Every change the studio makes to itself, newest first. Read only: nothing here can be edited or erased. Times are shown
          as how long ago, with the exact UTC time beneath.
        </p>
      </header>

      <nav aria-label="Filter by kind" className="-mx-1 flex flex-wrap gap-2 px-1">
        <Chip href={auditHref({})} current={!query.filter}>
          All
        </Chip>
        {AUDIT_FILTERS.map((f) => (
          <Chip key={f.id} href={auditHref({ filter: f.id })} current={query.filter === f.id}>
            {f.label}
          </Chip>
        ))}
      </nav>

      {query.ignored ? (
        <p role="note" className="max-w-prose rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
          That page link was not valid, so this shows the newest entries instead.
        </p>
      ) : null}

      {rows.length === 0 ? (
        query.before ? (
          <EmptyFrame message="Nothing older than this." action={<Pager newest={auditHref({ filter: query.filter })} older={null} />} />
        ) : (
          <EmptyFrame
            message="Nothing has happened yet."
            action={
              query.filter ? (
                <Link href={auditHref({})} className={cn("inline-flex min-h-11 items-center text-body text-text underline underline-offset-4 sm:min-h-9", focusRing)}>
                  Show every kind{filterLabel ? ` (not only ${filterLabel})` : ""}
                </Link>
              ) : undefined
            }
          />
        )
      ) : (
        <div data-testid="audit-list" className="flex min-w-0 flex-col gap-layout">
          {days.map((d) => (
            <section key={d.day} aria-labelledby={`day-${d.day}`} className="min-w-0 rounded-card bg-surface px-4 py-2 md:px-pad">
              <h2 id={`day-${d.day}`} className="flex items-baseline gap-3 pt-3 pb-1 text-small font-semibold tracking-wide text-faint uppercase">
                <span className="tabular-nums">{d.label}</span>
                <span className="font-normal normal-case">
                  {d.rows.length} {d.rows.length === 1 ? "entry" : "entries"} on this page
                </span>
              </h2>
              <ol className="m-0 list-none p-0">
                {d.rows.map((r) => (
                  <Entry key={r.id} row={r} now={now} />
                ))}
              </ol>
            </section>
          ))}
          <Pager newest={query.before ? auditHref({ filter: query.filter }) : null} older={next ? auditHref({ filter: query.filter, before: next }) : null} />
        </div>
      )}
    </div>
  );
}

function groupByDay(rows: AuditRow[]): { day: string; label: string; rows: AuditRow[] }[] {
  const out: { day: string; label: string; rows: AuditRow[] }[] = [];
  for (const r of rows) {
    const day = r.at.toISOString().slice(0, 10);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, label: `${r.at.getUTCDate()} ${r.at.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${r.at.getUTCFullYear()}`, rows: [r] });
  }
  return out;
}

function Chip({ href, current, children }: { href: string; current: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={current ? "true" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center rounded-control px-4 text-body whitespace-nowrap sm:min-h-9",
        current ? "bg-text font-medium text-ground" : "bg-raised text-muted hover:text-text",
        focusRing,
      )}
    >
      {children}
    </Link>
  );
}

function Pager({ newest, older }: { newest: string | null; older: string | null }) {
  if (!newest && !older) return null;
  const btn = cn("inline-flex min-h-11 items-center rounded-control bg-raised px-5 text-body font-medium text-text sm:min-h-9", focusRing);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center gap-3">
      {newest ? (
        <Link href={newest} className={btn}>
          Newest
        </Link>
      ) : null}
      {older ? (
        <Link href={older} rel="next" className={btn}>
          Older
        </Link>
      ) : null}
    </nav>
  );
}

const PROBLEM = (e: string) => e.endsWith(".failure") || e === "vault.unreadable";

function Entry({ row, now }: { row: AuditRow; now: Date }) {
  const known = isAuditEvent(row.event);
  const detail = row.detail && typeof row.detail === "object" && !Array.isArray(row.detail) ? row.detail : null;
  const { pairs, hidden } = describeDetail(detail);
  const iso = row.at.toISOString();
  return (
    <li
      data-testid="audit-row"
      data-audit-id={row.id}
      data-event={truncateText(row.event, 80)}
      className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 border-b border-rule py-4 last:border-b-0 lg:grid-cols-[12.5rem_14rem_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <time dateTime={iso} className="block text-body font-medium">
          {relativeTime(row.at, now)}
        </time>
        <span className="block font-mono text-small whitespace-nowrap text-faint tabular-nums">{utcStamp(row.at)}</span>
      </div>
      <div className="min-w-0">
        <p className="m-0 flex flex-wrap items-center gap-2 text-body [overflow-wrap:anywhere]">
          <span>{known ? AUDIT_EVENTS[row.event as keyof typeof AUDIT_EVENTS] : "Unrecognised event"}</span>
          {PROBLEM(row.event) ? <Pill tone="negative">Problem</Pill> : null}
        </p>
        <p className="m-0 mt-0.5 font-mono text-small text-faint [overflow-wrap:anywhere]">{truncateText(row.event, 60)}</p>
      </div>
      <div className="min-w-0">
        {pairs.length === 0 ? (
          <span className="text-small text-faint">No detail</span>
        ) : (
          <dl className="m-0 flex min-w-0 flex-wrap gap-x-5 gap-y-1">
            {pairs.map((p, i) => (
              <div key={i} className="flex min-w-0 max-w-full items-baseline gap-2 text-body">
                <dt className="shrink-0 font-mono text-small text-faint">{p.key}</dt>
                <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{p.value}</dd>
              </div>
            ))}
            {hidden > 0 ? <div className="text-small text-faint">and {hidden} more</div> : null}
          </dl>
        )}
      </div>
    </li>
  );
}
