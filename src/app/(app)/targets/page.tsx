import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { formatIst, formatMoney } from "@/server/core/display-format";
import { TARGET_MIN_SAMPLE } from "@/server/core/targets";
import { getPool } from "@/server/db/pool";
import { loadInrRate } from "@/server/db/system-settings";
import { loadTargets, type TargetRow } from "@/server/db/targets";
import { AddTargetForm, PauseForm, RemoveTargetForm, StartingTargetsButton } from "./target-forms";

// Targets. requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function TargetsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const STATUS = { on_track: "On track", behind: "Behind", no_data: "Not enough data" } as const;

function money(usd: number, rate: number): string {
  return formatMoney(Math.round(usd * 1e6), rate);
}
function show(t: TargetRow, v: number | null, rate: number): string {
  if (v === null) return "none yet";
  if (t.unit === "$") return money(v, rate);
  return `${v.toLocaleString("en-US")}${t.unit}`;
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [v, rate] = await Promise.all([loadTargets(db), loadInrRate(db)]);
  const name = (id: string | null) => (id === null ? "All channels" : v.channels.find((c) => c.channelId === id)?.title ?? id);
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Targets</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Numbers that say what &quot;working&quot; means for a channel. They only inform you, except one opt-in rule below. A target says &quot;not enough data&quot; until at least {TARGET_MIN_SAMPLE} shorts have numbers.
        </p>
      </header>

      <section aria-labelledby="t-h" className="flex flex-col gap-4 rounded-card bg-surface p-pad">
        <h2 id="t-h" className="text-title font-semibold">Your targets</h2>
        {v.targets.length === 0 ? (
          <p className="text-body text-muted">No targets yet. Add one below, or use the starting targets.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {v.targets.map((t) => (
              <li key={t.id} className="flex min-w-0 flex-wrap items-center justify-between gap-3" data-testid="target-row">
                <span className="min-w-0 text-body">
                  <span className="font-medium">{t.label}</span> <span className="text-muted">({name(t.channelId)})</span>
                  <br />
                  <span className="text-small text-muted">
                    Target {t.op === ">=" ? "at least" : "at most"} {show(t, t.value, rate)} · now {show(t, t.actual, rate)} · {t.n} short{t.n === 1 ? "" : "s"} with data
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-body font-medium">{STATUS[t.status]}</span>
                  <RemoveTargetForm id={t.id} label={t.label} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <StartingTargetsButton />
      </section>

      <section aria-labelledby="a-h" className="flex flex-col gap-4 rounded-card bg-surface p-pad">
        <h2 id="a-h" className="text-title font-semibold">Add or change a target</h2>
        <p className="text-small text-muted">Saving a target that already exists for the same channel and metric replaces it.</p>
        <AddTargetForm channels={v.channels} />
      </section>

      <section aria-labelledby="p-h" className="flex flex-col gap-4 rounded-card bg-surface p-pad">
        <h2 id="p-h" className="text-title font-semibold">Pause rule and revenue estimate</h2>
        <p className="max-w-[60ch] text-body text-muted">
          If cost per 1,000 views is over your target for each of the last N shorts, overnight drafting is switched off once and you get a notice. It never switches anything on. Overnight drafting is currently {v.drafting ? "on" : "off"}.
          {v.pauseFired ? ` It last paused drafting on ${formatIst(new Date(v.pauseFired))}. Saving below lets it fire again.` : ""}
        </p>
        <PauseForm pauseN={v.pauseN} rpmUsd={v.rpmUsd} />
        {v.estimateUsd !== null ? (
          <p className="text-body" data-testid="revenue-estimate">
            Revenue estimate: {money(v.estimateUsd, rate)} <span className="text-muted">(an estimate from your own rate and {v.totalViews.toLocaleString("en-US")} views, not real revenue)</span>
          </p>
        ) : null}
      </section>
    </div>
  );
}
