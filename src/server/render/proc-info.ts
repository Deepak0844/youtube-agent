import { execFile } from "node:child_process";

// Reads a process's identity from `ps`: start time (whole seconds), pgid and full command line. The same source is used when a
// child is registered and when the boot sweep re-checks it, so the two readings agree. null = no such process (or ps failed).
export interface ProcInfo {
  startedAtEpoch: number;
  pgid: number;
  args: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// `ps -o lstart=` prints local time like "Mon Oct 27 10:00:00 2026" (C locale, same on macOS and Linux).
export function parseLstart(s: string): number | null {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(s);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]!);
  if (mon < 0) return null;
  const ms = new Date(Number(m[6]), mon, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function psEnv(): NodeJS.ProcessEnv {
  const e: Record<string, string> = { LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" };
  return e as NodeJS.ProcessEnv;
}

function ps(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", args, { env: psEnv(), timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    );
  });
}

export async function readProcInfo(pid: number): Promise<ProcInfo | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const [start, pgid, args] = await Promise.all([
    ps(["-o", "lstart=", "-p", String(pid)]),
    ps(["-o", "pgid=", "-p", String(pid)]),
    ps(["-ww", "-o", "args=", "-p", String(pid)]),
  ]);
  if (start === null || pgid === null || args === null) return null;
  const startedAtEpoch = parseLstart(start.trim());
  const g = Number(pgid.trim());
  if (startedAtEpoch === null || !Number.isInteger(g) || !args.trim()) return null;
  return { startedAtEpoch, pgid: g, args: args.trim() };
}

/** First word of the command line, reduced to its file name. Paths containing spaces do not match (fail safe: no kill). */
export function commandLabelOf(args: string): string {
  const first = args.trim().split(/\s+/)[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}
