import { z } from "zod";

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

export type JobName = "analytics" | "competitors";
export interface DueJob {
  job: JobName;
  /** One value per run period; a job with this (job, runKey) already logged is never started again, even if it failed. */
  runKey: string;
}

const IST_OFFSET_MS = 5.5 * 3600_000;

/** Calendar date and hour in IST. */
export function istParts(now: Date): { date: string; hour: number } {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export function dueJobs(s: SchedulerSettings, now: Date): DueJob[] {
  const { date, hour: h } = istParts(now);
  const out: DueJob[] = [];
  if (s.analytics && h >= ANALYTICS_FROM_HOUR) out.push({ job: "analytics", runKey: date });
  const minutes = h * 60 + new Date(now.getTime() + IST_OFFSET_MS).getUTCMinutes();
  if (s.competitors && minutes >= COMPETITORS_FROM_MINUTE) out.push({ job: "competitors", runKey: date });
  return out;
}
