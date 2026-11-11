import { z } from "zod";
import { formatIst } from "@/server/core/display-format";

// Backup rules and result shape. Pure: no IO. The runner is src/server/db/backup.ts.
// One backup = one folder <storage>/backups/backup-YYYYMMDDTHHMMSSZ holding db.dump and storage.tar.gz.

export const KEEP_BACKUPS = 7;
/** A backup is made every 6 hours (the old app did the same). After a failed one the next try comes sooner. */
export const BACKUP_EVERY_MS = 6 * 3_600_000;
export const BACKUP_RETRY_AFTER_FAIL_MS = 3_600_000;

/** Fixed sentences only: a driver or tool message could carry a connection string. */
export const backupResultSchema = z
  .union([
    // extra: what happened to the optional second copy (absent = none is set up)
    z.object({ ok: z.literal(true), at: z.string().datetime(), bytes: z.number().int().nonnegative(), name: z.string().max(40), extra: z.enum(["copied", "failed"]).optional() }).strict(),
    z.object({ ok: z.literal(false), at: z.string().datetime(), error: z.string().max(200) }).strict(),
  ])
  .nullable();
export type BackupResult = NonNullable<z.infer<typeof backupResultSchema>>;

const NAME = /^backup-\d{8}T\d{6}Z$/;
export const isBackupName = (n: string): boolean => NAME.test(n);

export function backupName(d: Date): string {
  return `backup-${d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

/** Newest `keep` backup folders stay; older ones are returned for deletion. Anything not named like a backup is never touched. */
export function backupsToDelete(names: readonly string[], keep = KEEP_BACKUPS): string[] {
  return names.filter(isBackupName).sort().reverse().slice(Math.max(keep, 1));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export interface BackupView {
  tone: "none" | "ok" | "failed";
  text: string;
}

export function describeBackup(r: BackupResult | null): BackupView {
  if (!r) return { tone: "none", text: "No backup has been made yet." };
  if (r.ok) {
    const extra = r.extra === "copied" ? " Also copied to your extra folder." : r.extra === "failed" ? " The extra copy to your folder FAILED; check the folder is there and has room." : "";
    return { tone: r.extra === "failed" ? "failed" : "ok", text: `Last backup ${formatIst(new Date(r.at))}, ${formatBytes(r.bytes)}.${extra}` };
  }
  return { tone: "failed", text: `Backup failed at ${formatIst(new Date(r.at))}. ${r.error}` };
}

export const NO_DUMP_MESSAGE = "Install Postgres client tools or start the database container.";
export const DEFAULT_DB_CONTAINER = "ytstudio-dev-pg";

export type DumpPlan = { kind: "local" } | { kind: "docker"; args: string[] } | { kind: "none"; message: string };

/** Which way to dump: pg_dump on PATH first, else pg_dump inside the running database container (its own local trust login, no password). */
export function dumpPlan(a: { pgDump: boolean; containerRunning: boolean }, o: { container: string; user: string; db: string }): DumpPlan {
  if (a.pgDump) return { kind: "local" };
  if (a.containerRunning) return { kind: "docker", args: ["exec", "-i", o.container, "pg_dump", "--format=custom", "-U", o.user, o.db] };
  return { kind: "none", message: NO_DUMP_MESSAGE };
}

/** True when it is time for another scheduled backup: none yet, or the last one is old enough (sooner after a failure). */
export function backupDue(last: BackupResult | null, now: Date): boolean {
  if (!last) return true;
  const age = now.getTime() - new Date(last.at).getTime();
  if (!Number.isFinite(age) || age < 0) return false; // a clock that went backwards: wait rather than back up in a loop
  return age >= (last.ok ? BACKUP_EVERY_MS : BACKUP_RETRY_AFTER_FAIL_MS);
}

/**
 * The backup a restore command means: "--latest" or a backup folder name (a path is cut to its last part, so a pasted full path works). Only a folder that
 * is named like a backup is ever chosen; anything else is a plain refusal, never a path that could point somewhere else.
 */
export function pickBackup(names: readonly string[], arg: string): { ok: true; name: string } | { ok: false; reason: string } {
  const backups = names.filter(isBackupName).sort();
  if (backups.length === 0) return { ok: false, reason: "There are no backups to restore from." };
  if (arg === "--latest") return { ok: true, name: backups[backups.length - 1]! };
  const last = arg.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!isBackupName(last)) return { ok: false, reason: "That is not the name of a backup. Run the list command to see them." };
  return backups.includes(last) ? { ok: true, name: last } : { ok: false, reason: `There is no backup called ${last}. Run the list command to see them.` };
}

const COPY_START = /^COPY\s+(?:\S+\.)?schema_migrations\s*\(([^)]*)\)\s+FROM stdin;/;

/** The migration names inside the schema_migrations COPY block of a plain-text data dump (pg_restore --data-only -t schema_migrations). */
export function parseMigrationNames(dump: string): string[] {
  const lines = dump.split("\n");
  const start = lines.findIndex((l) => COPY_START.test(l));
  if (start < 0) return [];
  const cols = (COPY_START.exec(lines[start]!)![1] ?? "").split(",").map((c) => c.trim());
  const nameAt = cols.indexOf("name");
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l === "\\.") break;
    const v = l.split("\t")[nameAt < 0 ? 0 : nameAt];
    if (v && /^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/.test(v)) out.push(v);
  }
  return out;
}

/** Why a dump cannot be restored on this version of the app, or null: its database is NEWER than the app (it holds migrations this app does not have). */
export function schemaProblem(dumpMigrations: readonly string[], appMigrations: readonly string[]): string | null {
  if (dumpMigrations.length === 0) return "This backup does not say which database version it holds, so it cannot be checked. Nothing was changed.";
  const have = new Set(appMigrations);
  const newer = dumpMigrations.filter((m) => !have.has(m)).sort();
  return newer.length === 0 ? null : `This backup is from a NEWER version of the app (it has ${newer.length} database change${newer.length === 1 ? "" : "s"} this app does not know, the first is ${newer[0]}). Update the app first. Nothing was changed.`;
}

/** Folders a backup copy must never be sent into (system folders), as plain prefixes. */
const PROTECTED = ["/System", "/usr", "/bin", "/sbin", "/etc", "/var", "/private", "/Library", "/Applications", "/dev", "/proc", "/sys", "/boot", "/opt", "/cores"];

/** The checks on the optional extra-copy folder that need no disk: an absolute plain path that is not a system folder and not inside the app's own storage. */
export function extraDirProblem(dir: string, storageRoot: string): string | null {
  const d = dir.trim();
  if (d === "") return null; // empty = off
  if (d.length > 400 || /[\u0000-\u001f]/.test(d)) return "That folder name is not usable.";
  if (!d.startsWith("/")) return "Give the full folder path, starting with / (for an external drive on a Mac it starts with /Volumes/).";
  const parts = d.split("/").filter(Boolean);
  if (parts.length === 0) return "Pick a folder, not the whole disk.";
  if (parts.some((p) => p === "." || p === "..")) return "Give the folder path without . or .. parts.";
  const norm = `/${parts.join("/")}`;
  if (PROTECTED.some((p) => norm === p || norm.startsWith(`${p}/`))) return "That is a system folder. Pick a folder of your own, or an external drive under /Volumes/.";
  const root = `/${storageRoot.split("/").filter(Boolean).join("/")}`;
  if (norm === root || norm.startsWith(`${root}/`) || root.startsWith(`${norm}/`)) return "That folder is the app's own storage (or contains it). Pick a different one.";
  return null;
}
