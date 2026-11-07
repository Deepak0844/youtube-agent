import { DRAFT_WINDOW_HOURS } from "./scheduler";

// Pure helpers for the Calendar page. Hours are IST (UTC+5:30, no daylight saving), as in scheduler.ts.
const IST_OFFSET_MS = 5.5 * 3600_000;
const DAY_MS = 86_400_000;
const WINDOW_MS = DRAFT_WINDOW_HOURS * 3600_000;

/** The overnight window running now (inWindow) or the next one to start. Same window rule as dueJobs, wrapping past midnight. */
export function nextDraftWindow(now: Date, startHour: number): { start: Date; inWindow: boolean } {
  const ist = now.getTime() + IST_OFFSET_MS;
  const today = Math.floor(ist / DAY_MS) * DAY_MS + startHour * 3600_000;
  const current = ist >= today ? today : today - DAY_MS; // latest start at or before now
  const inWindow = ist - current < WINDOW_MS;
  const startIst = inWindow ? current : current + DAY_MS;
  return { start: new Date(startIst - IST_OFFSET_MS), inWindow };
}

/** Counts from a drafting run's message ("2 started, 0 failed, 1 skipped as duplicates; ..."); null if it is not in that form. */
export function parseRunCounts(message: string | null): { started: number; failed: number; skipped: number } | null {
  const m = /^(\d+) started, (\d+) failed, (\d+) skipped/.exec(message ?? "");
  return m ? { started: Number(m[1]), failed: Number(m[2]), skipped: Number(m[3]) } : null;
}
