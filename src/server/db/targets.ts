import type pg from "pg";
import {
  TARGET_METRICS, TARGET_METRIC_IDS, actuals, evaluate, subscriberActual, overTargetForLast, revenueEstimateUsd, isTargetMetric,
  type Actual, type ShortNumbers, type TargetMetric, type TargetStatus,
} from "@/server/core/targets";
import { recordAudit } from "@/server/db/audit";
import { loadAnalytics, type AnalyticsRow } from "@/server/db/analytics";
import { notifySafe, type NotifySend } from "@/server/db/notify";
import { pauseDraftingForTargets } from "@/server/db/settings";
import { loadScheduler, loadTargetSettings } from "@/server/db/system-settings";

// Targets: the owner's numbers per channel (or all channels), checked against the newest analytics snapshots and the spend ledger.
// Callers (server actions) have already done requireOwner(). Errors returned to the page are fixed sentences.

export interface TargetRow {
  id: number;
  channelId: string | null;
  metric: TargetMetric;
  op: ">=" | "<=";
  value: number;
  label: string;
  unit: string;
  actual: number | null;
  n: number;
  status: TargetStatus;
}
export interface TargetsView {
  targets: TargetRow[];
  channels: Array<{ channelId: string; title: string }>;
  pauseN: number;
  pauseFired: string | null;
  drafting: boolean;
  rpmUsd: number;
  totalViews: number;
  estimateUsd: number | null;
}

const numbers = (r: AnalyticsRow): ShortNumbers => ({ views: r.views, avgViewPct: r.avgViewPct, spendMicroUsd: r.spendMicroUsd });

export async function loadTargets(db: pg.Pool): Promise<TargetsView> {
  const [analytics, t, ch, s, sched, subs] = await Promise.all([
    loadAnalytics(db),
    db.query<{ id: string; channel_id: string | null; metric: string; op: ">=" | "<="; value: string }>("select id, channel_id, metric, op, value::text from targets order by channel_id nulls first, id"),
    db.query<{ channel_id: string; title: string }>("select channel_id, title from youtube_channels order by title"),
    loadTargetSettings(db),
    loadScheduler(db),
    db.query<{ channel_id: string; gained: string | null; lost: string | null }>(
      "select distinct on (channel_id) channel_id, subscribers_gained::text as gained, subscribers_lost::text as lost from channel_analytics where error is null order by channel_id, day desc",
    ),
  ]);
  const shorts = analytics.rows;
  const subRows = subs.rows.map((r) => ({ channelId: r.channel_id, gained: r.gained === null ? null : Number(r.gained), lost: r.lost === null ? null : Number(r.lost) }));
  const targets = t.rows.flatMap((r): TargetRow[] => {
    if (!isTargetMetric(r.metric)) return [];
    const mine = shorts.filter((x) => r.channel_id === null || x.channelId === r.channel_id).map(numbers);
    const weekly = r.metric === "subscribers_per_week";
    const a: Actual = weekly ? subscriberActual(subRows.filter((x) => r.channel_id === null || x.channelId === r.channel_id)) : actuals(mine)[r.metric];
    const info = TARGET_METRICS[r.metric];
    // A weekly channel number needs one channel with data, not five shorts.
    return [{ id: Number(r.id), channelId: r.channel_id, metric: r.metric, op: r.op, value: Number(r.value), label: info.label, unit: info.unit, actual: a.value, n: a.n, status: evaluate(a, r.op, Number(r.value), weekly ? 1 : undefined) }];
  });
  const totalViews = shorts.reduce((a, x) => a + (x.views ?? 0), 0);
  return {
    targets,
    channels: ch.rows.map((c) => ({ channelId: c.channel_id, title: c.title || c.channel_id })),
    pauseN: s.pauseN,
    pauseFired: s.pauseFired,
    drafting: sched.enabled,
    rpmUsd: s.rpmUsd,
    totalViews,
    estimateUsd: revenueEstimateUsd(totalViews, s.rpmUsd),
  };
}

export type TargetResult = { ok: true } | { ok: false; error: string };
const GENERIC = "That could not be saved. Check the values and try again.";

export async function saveTarget(db: pg.Pool, input: { channelId: string | null; metric: unknown; value: unknown }, sessionId?: string): Promise<TargetResult> {
  if (!isTargetMetric(input.metric)) return { ok: false, error: "Pick a metric from the list." };
  const raw = typeof input.value === "string" ? input.value.trim() : "";
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(raw)) return { ok: false, error: "Enter the target as a plain number, such as 70 or 2.50." };
  const channelId = input.channelId && input.channelId.length > 0 ? input.channelId : null;
  if (channelId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(channelId)) return { ok: false, error: GENERIC };
  const op = TARGET_METRICS[input.metric].op;
  try {
    await db.query(
      `insert into targets (channel_id, metric, op, value) values ($1, $2, $3, $4)
       on conflict (coalesce(channel_id, ''), metric) do update set op = excluded.op, value = excluded.value`,
      [channelId, input.metric, op, raw],
    );
    await recordAudit(db, "target.saved", { channel: channelId ?? "all", metric: input.metric, op, value: Number(raw), session: sessionId });
    return { ok: true };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

export async function removeTarget(db: pg.Pool, id: unknown, sessionId?: string): Promise<TargetResult> {
  if (typeof id !== "string" || !/^\d{1,18}$/.test(id)) return { ok: false, error: GENERIC };
  try {
    const { rows } = await db.query<{ metric: string }>("delete from targets where id = $1 returning metric", [id]);
    if (rows[0]) await recordAudit(db, "target.deleted", { id: Number(id), metric: rows[0].metric, session: sessionId });
    return { ok: true };
  } catch {
    return { ok: false, error: GENERIC };
  }
}

/** The recommended starters, for all channels, only where none is set yet. Views and cost per 1,000 wait for real data. */
export async function applyStartingTargets(db: pg.Pool, sessionId?: string): Promise<{ made: TargetMetric[] }> {
  const made: TargetMetric[] = [];
  for (const m of TARGET_METRIC_IDS) {
    const start = TARGET_METRICS[m].start;
    if (start === null) continue;
    const { rowCount } = await db.query(
      "insert into targets (channel_id, metric, op, value) values (null, $1, $2, $3) on conflict (coalesce(channel_id, ''), metric) do nothing",
      [m, TARGET_METRICS[m].op, start],
    );
    if (rowCount) {
      made.push(m);
      await recordAudit(db, "target.saved", { channel: "all", metric: m, op: TARGET_METRICS[m].op, value: start, session: sessionId, starting: true });
    }
  }
  return { made };
}

/**
 * The pause rule. Called by the worker after each analytics pull. If it is on (N > 0), drafting is on, and cost per 1,000 views was over
 * the all-channels target for each of the last N shorts, drafting is switched off once and the owner is told. Never turns anything on.
 */
export async function checkTargetPause(db: pg.Pool, send?: NotifySend): Promise<boolean> {
  const s = await loadTargetSettings(db);
  if (s.pauseN <= 0 || s.pauseFired !== null || !(await loadScheduler(db)).enabled) return false;
  const { rows } = await db.query<{ value: string }>("select value::text from targets where metric = 'cost_per_1k_views' and channel_id is null");
  if (!rows[0]) return false;
  const target = Number(rows[0].value);
  const oldestFirst = (await loadAnalytics(db)).rows.slice().reverse().map(numbers);
  if (!overTargetForLast(oldestFirst, s.pauseN, target)) return false;
  if (!(await pauseDraftingForTargets(db))) return false;
  await recordAudit(db, "target.pause_fired", { target_usd: target, shorts: s.pauseN });
  await notifySafe(db, send, {
    event: "drafting_paused", from: "drafting_on", to: "drafting_paused", transitionId: `pause.${Date.now()}`,
    detail: `Cost per 1,000 views stayed above $${target.toFixed(2)} for the last ${s.pauseN} shorts.`,
  });
  return true;
}
