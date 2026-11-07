import type pg from "pg";
import { findSimilar } from "@/server/core/ideas";
import { draftStop, type DraftStop } from "@/server/core/scheduler";
import { recordAudit } from "@/server/db/audit";
import { draftIdeaAs } from "@/server/db/ideas";
import type { EnqueueOnly } from "@/server/db/pipeline";
import { getBudget } from "@/server/db/spend";
import { utcPeriods } from "@/server/db/budget-scopes";
import { loadScheduler } from "@/server/db/system-settings";

// Overnight drafting (Phase 6.6). One run per night (schedule_runs key). Starts normal videos from the best proposed ideas, one at a
// time, through the same path as Draft now. It never approves a gate, verifies evidence, uploads or publishes: a video stops at its
// first gate as the pipeline already does. Settings are re-read before every draft so an off switch stops the run at once.

const CANDIDATES = 50;

/** Money left in micro-USD: the smaller of today's and this month's (copy if it exists, else the template). null = no limit. */
export async function budgetLeftMicro(db: pg.Pool): Promise<number | null> {
  const { day, month } = await utcPeriods(db);
  let left: number | null = null;
  for (const [copy, template] of [[`day:${day}`, "day"], [`month:${month}`, "month"]] as const) {
    const b = (await getBudget(db, copy)) ?? (await getBudget(db, template));
    if (!b) return 0; // no budget row at all: refuse to spend
    if (b.capMicroUsd === null) continue;
    const used = copy === b.scope ? b.reservedMicroUsd + b.spentMicroUsd : 0;
    const l = b.capMicroUsd - used;
    left = left === null ? l : Math.min(left, l);
  }
  return left;
}

async function waitingForOwner(db: pg.Pool): Promise<number> {
  const { rows } = await db.query<{ n: string }>("select count(*) as n from videos where status = 'waiting'");
  return Number(rows[0]!.n);
}

const REASON: Record<DraftStop, string> = {
  disabled: "switched off",
  max_drafts: "nightly draft limit reached",
  max_pending: "enough drafts already waiting for you",
  low_budget: "less than $1 left today or this month",
  failures: "2 failed starts",
};

export async function runOvernightDrafting(db: pg.Pool, queue: EnqueueOnly): Promise<string> {
  const { rows: ideas } = await db.query<{ id: string }>(
    "select id from ideas where status = 'proposed' order by score desc, created_at, id limit $1",
    [CANDIDATES],
  );
  const { rows: topics } = await db.query<{ topic: string }>("select topic from videos");
  const known = topics.map((t) => t.topic);
  const state = { started: 0, failed: 0, waiting: await waitingForOwner(db), budgetLeftMicro: await budgetLeftMicro(db) };
  let skipped = 0;
  let stop: DraftStop | null = null;
  for (const { id } of ideas) {
    const s = await loadScheduler(db);
    state.waiting = await waitingForOwner(db);
    state.budgetLeftMicro = await budgetLeftMicro(db);
    stop = draftStop(s, state);
    if (stop) break;
    const { rows } = await db.query<{ topic: string }>("select topic from ideas where id = $1 and status = 'proposed'", [id]);
    const topic = rows[0]?.topic;
    if (!topic) continue; // dismissed or drafted since we looked
    if (findSimilar(topic, known)) { skipped++; continue; }
    let r: { ok: true; videoId: string } | { ok: false; message: string };
    try {
      r = await draftIdeaAs(db, queue, null, id, { kind: s.tracks[0] ?? "tsx", language: "en" });
    } catch {
      r = { ok: false, message: "error" };
    }
    if (!r.ok) { state.failed++; continue; }
    state.started++;
    known.push(topic);
    await recordAudit(db, "scheduler.draft_started", { ideaId: id, videoId: r.videoId, kind: s.tracks[0] ?? "tsx", night: state.started });
  }
  // Out of ideas is the quiet end; a limit reached on the last idea still gets named.
  if (!stop && ideas.length) stop = draftStop(await loadScheduler(db), { ...state, waiting: await waitingForOwner(db), budgetLeftMicro: await budgetLeftMicro(db) });
  const why = stop ? `stopped: ${REASON[stop]}` : ideas.length ? "no more usable ideas" : "no ideas waiting";
  return `${state.started} started, ${state.failed} failed, ${skipped} skipped as duplicates; ${why}`;
}
