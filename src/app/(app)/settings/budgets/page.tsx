import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { microToDollars } from "@/server/core/spend";
import { BUDGET_LABELS } from "@/server/core/settings-registry";
import { listAudit } from "@/server/db/audit";
import { listBudgetTemplates } from "@/server/db/budget-scopes";
import { getPool } from "@/server/db/pool";
import { CapRow } from "./cap-row";

// Spending limits. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function BudgetsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const what = (scope: string): string =>
  scope.startsWith("video:") ? "this kind of video" : scope === "day" ? "a day" : scope === "month" ? "a month" : "a draft run";
const cap = (n: unknown): string => (n === null || n === undefined ? "no limit" : typeof n === "number" ? microToDollars(n) : "?");

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [{ templates, today, month }, recent] = await Promise.all([listBudgetTemplates(db), listAudit(db, { eventPrefix: "budget.cap_changed", limit: 8 })]);

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Budgets</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          The most the studio may spend, per video and per day or month. A limit of $0 stops all spending. &quot;No limit&quot; lifts the limit completely.
          Raising a limit reaches new days, months and videos; a video already started keeps the limit it began with. Every change is written to the audit log.
        </p>
      </header>

      <section aria-labelledby="spent-h" className="rounded-card bg-surface p-pad">
        <h2 id="spent-h" className="text-title font-semibold">Spending so far</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {[["Today", today], ["This month", month]].map(([label, t]) => (
            <div key={label as string} data-testid={`spent-${(label as string).toLowerCase().replace(" ", "-")}`}>
              <dt className="text-small text-muted">{label as string} (UTC)</dt>
              <dd className="text-body tabular-nums">
                {microToDollars((t as typeof today).spentMicroUsd)} spent
                <span className="text-muted">, {microToDollars((t as typeof today).reservedMicroUsd)} set aside for steps in progress</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="caps-h" className="flex flex-col gap-gap">
        <h2 id="caps-h" className="sr-only">Limits</h2>
        <ul className="flex flex-col gap-gap">
          {templates.map((t) => {
            const l = BUDGET_LABELS[t.scope]!;
            return (
              <CapRow
                key={t.scope}
                scope={t.scope}
                title={l.title}
                note={l.note}
                capLabel={t.capMicroUsd === null ? null : microToDollars(t.capMicroUsd)}
                capInput={t.capMicroUsd === null ? "" : (t.capMicroUsd / 1_000_000).toString()}
                what={what(t.scope)}
              />
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="recent-h" className="rounded-card bg-surface p-pad">
        <h2 id="recent-h" className="text-title font-semibold">Recent changes</h2>
        {recent.rows.length === 0 ? (
          <p className="mt-2 text-body text-muted">No limit has been changed yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {recent.rows.map((r) => {
              const d = r.detail ?? {};
              const title = BUDGET_LABELS[String(d.scope)]?.title ?? "A limit";
              return (
                <li key={r.id} data-testid="budget-audit-row" className="text-body">
                  {title}: {cap(d.oldCapMicroUsd)} to {cap(d.newCapMicroUsd)}
                  <time dateTime={r.at.toISOString()} className="ml-2 text-small text-muted">
                    {r.at.toISOString().slice(0, 19).replace("T", " ")} UTC
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
