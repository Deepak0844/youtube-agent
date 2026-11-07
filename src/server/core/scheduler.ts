import { z } from "zod";
import { researchDue, type ResearchState } from "./idea-research";
import { isoWeek } from "./insights";

// Scheduler settings (Phase 6, parity with the old agent/scheduler.py DEFAULTS) and the pure "what is due now" rule. No IO.
// Hours are IST (Asia/Kolkata, UTC+5:30, no daylight saving), the zone the app shows everywhere. weekly_day: 0 = Monday ... 6 = Sunday.
const hour = z.number().int().min(0).max(23);

export const schedulerSchema = z
  .object({
    enabled: z.boolean(), // overnight drafting; spends money up to the caps, so it is off until the owner confirms
    hour, // start of the 3 hour drafting window
    max_drafts: z.number().int().min(0).max(5),
    research: z.boolean(),
    max_pending: z.number().int().min(1).max(10),
    tracks: z.array(z.enum(["tsx"])).length(1), // fixed for now: other tracks arrive in Phase 8
    analytics: z.boolean(), // daily analytics pull: read only, quota guarded
    weekly_review: z.boolean(),
    weekly_day: z.number().int().min(0).max(6),
    weekly_hour: hour,
    optimizer: z.boolean(),
    optimizer_hour: hour,
    competitors: z.boolean(),
  })
  .strict();

export type SchedulerSettings = z.infer<typeof schedulerSchema>;

export const SCHEDULER_DEFAULTS: SchedulerSettings = {
  enabled: false,
  hour: 2,
  max_drafts: 2,
  research: true,
  max_pending: 3,
  tracks: ["tsx"],
  analytics: true,
  weekly_review: true,
  weekly_day: 6,
  weekly_hour: 20,
  optimizer: false,
  optimizer_hour: 22,
  competitors: true,
};

export const ANALYTICS_FROM_HOUR = 9;

export const COMPETITORS_FROM_MINUTE = 9 * 60 + 30; // 09:30 IST, after the analytics pull

export type JobName = "drafting" | "analytics" | "competitors" | "research" | "weekly_review" | "optimizer";
export interface DueJob {
  job: JobName;
  /** One value per run period; a job with this (job, runKey) already logged is never started again, even if it failed. */
  runKey: string;
}

export const DRAFT_WINDOW_HOURS = 3;
export const MAX_FAILURES_PER_NIGHT = 2;
export const MIN_DAY_BUDGET_LEFT_MICRO = 1_000_000; // $1

const IST_OFFSET_MS = 5.5 * 3600_000;

/** Calendar date and hour in IST. */
export function istParts(now: Date): { date: string; hour: number } {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

/** `research` is the idea backlog state; without it the idea researcher is never due (the caller reads it from the database). */
export function dueJobs(s: SchedulerSettings, now: Date, research?: ResearchState & { runsToday: number }): DueJob[] {
  const { date, hour: h } = istParts(now);
  const out: DueJob[] = [];
  // Overnight drafting: [hour, hour + 3) IST, wrapping past midnight. The key is the date the window STARTED, so one run per night.
  if (s.enabled && (h - s.hour + 24) % 24 < DRAFT_WINDOW_HOURS) {
    const startedYesterday = h < s.hour;
    const key = startedYesterday ? new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : date;
    out.push({ job: "drafting", runKey: key });
  }
  if (s.analytics && h >= ANALYTICS_FROM_HOUR) out.push({ job: "analytics", runKey: date });
  const minutes = h * 60 + new Date(now.getTime() + IST_OFFSET_MS).getUTCMinutes();
  if (s.competitors && minutes >= COMPETITORS_FROM_MINUTE) out.push({ job: "competitors", runKey: date });
  // Idea researcher: backlog under 5 and none in the last 20 hours; the key is the IST date plus a counter, so it can run again tomorrow.
  if (s.research && research && researchDue(research)) out.push({ job: "research", runKey: `${date}.${research.runsToday + 1}` });
  // Weekly review: the chosen IST weekday (0 = Monday) from the chosen hour, once per ISO week.
  const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (s.weekly_review && weekday === s.weekly_day && h >= s.weekly_hour) out.push({ job: "weekly_review", runKey: isoWeek(date) });
  // Optimizer: proposals only; once per IST day from its hour.
  if (s.optimizer && h >= s.optimizer_hour) out.push({ job: "optimizer", runKey: date });
  return out;
}

export interface DraftState {
  started: number; // drafts started in this run
  failed: number; // failed starts in this run
  waiting: number; // videos waiting for the owner at a gate right now
  /** Money left today (and this month) in micro-USD, the smaller of the two; null = no limit. */
  budgetLeftMicro: number | null;
}
export type DraftStop = "disabled" | "max_drafts" | "max_pending" | "low_budget" | "failures";

/** Whether one more draft may start. Videos started in this run count as waiting: they will reach a gate. Pure. */
export function draftStop(s: Pick<SchedulerSettings, "enabled" | "max_drafts" | "max_pending">, st: DraftState): DraftStop | null {
  if (!s.enabled) return "disabled";
  if (st.failed >= MAX_FAILURES_PER_NIGHT) return "failures";
  if (st.started >= s.max_drafts) return "max_drafts";
  if (st.waiting + st.started >= s.max_pending) return "max_pending";
  if (st.budgetLeftMicro !== null && st.budgetLeftMicro < MIN_DAY_BUDGET_LEFT_MICRO) return "low_budget";
  return null;
}
