import { KnownFailure } from "@/server/core/paid-call";
import { LIMIT } from "@/server/llm/claude-code";

// Claude Code's usage-limit messages (ADR 0015). Two forms are known: "Claude AI usage limit reached|<epoch seconds>" and
// "You've hit/reached your [weekly] limit · resets [Fri] 8[:30]pm (Area/City)". A limit with no readable time still counts as a
// limit (the step then retries after engine.limit_retry_s). Times are shown to the owner in IST.

const IST = "Asia/Kolkata";
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function zoneOk(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `d` in `tz`. */
function wall(d: Date, tz: string): { y: number; m: number; day: number; wd: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), day: Number(p.day), wd: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}

/** The UTC instant of a wall-clock time in `tz` (two passes settle the zone offset, DST included). */
function wallToUtc(y: number, m: number, day: number, h: number, min: number, tz: string): Date {
  let t = Date.UTC(y, m - 1, day, h, min);
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    t += Date.UTC(y, m - 1, day, h, min) - shown;
  }
  return new Date(t);
}

export function parseLimit(text: string, now: Date): { limit: boolean; resumeAt: Date | null } {
  const s = (text ?? "").trim();
  if (!LIMIT.test(s)) return { limit: false, resumeAt: null };
  const epoch = /\|(\d{9,11})\b/.exec(s);
  if (epoch) {
    const at = new Date(Number(epoch[1]) * 1000);
    return { limit: true, resumeAt: at > now ? at : null };
  }
  const m = /resets\s+(?:(sun|mon|tue|wed|thu|fri|sat)\w*\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([A-Za-z_]+\/[A-Za-z_]+)\))?/i.exec(s);
  if (!m) return { limit: true, resumeAt: null };
  let h = Number(m[2]);
  const min = Number(m[3] ?? 0);
  if (h < 1 || h > 12 || min > 59) return { limit: true, resumeAt: null };
  if (m[4]!.toLowerCase() === "pm" && h !== 12) h += 12;
  if (m[4]!.toLowerCase() === "am" && h === 12) h = 0;
  const tz = m[5] && zoneOk(m[5]) ? m[5] : IST;
  const want = m[1] ? DAYS.indexOf(m[1].toLowerCase()) : -1;
  const today = wall(now, tz);
  for (let add = 0; add <= 7; add++) {
    const base = new Date(Date.UTC(today.y, today.m - 1, today.day + add, 12));
    const w = wall(base, "UTC");
    if (want >= 0 && w.wd !== want) continue;
    const at = wallToUtc(w.y, w.m, w.day, h, min, tz);
    if (at > now) return { limit: true, resumeAt: at };
  }
  return { limit: true, resumeAt: null };
}

/** "8:00 PM" on the same IST day as `now`, otherwise "Fri 9:30 AM". */
export function istTime(d: Date, now: Date = new Date()): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: IST, hour: "numeric", minute: "2-digit" }).format(d);
  const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(x);
  if (day(d) === day(now)) return time;
  return `${new Intl.DateTimeFormat("en-US", { timeZone: IST, weekday: "short" }).format(d)} ${time}`;
}

/** A step stopped by the Claude usage limit. A KnownFailure, so the retry sweep leaves it alone; the engine resume sweep queues
 *  it again after `resumeAt`. */
export class EngineLimitError extends KnownFailure {
  constructor(readonly resumeAt: Date, now: Date = new Date()) {
    super(`Claude limit reached. This step resumes about ${istTime(resumeAt, now)} IST by itself.`);
    this.name = "EngineLimitError";
  }
}
