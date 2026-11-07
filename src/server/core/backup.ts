import { z } from "zod";
import { formatIst } from "@/server/core/display-format";

// Backup rules and result shape. Pure: no IO. The runner is src/server/db/backup.ts.
// One backup = one folder <storage>/backups/backup-YYYYMMDDTHHMMSSZ holding db.dump and storage.tar.gz.

export const KEEP_BACKUPS = 7;

/** Fixed sentences only: a driver or tool message could carry a connection string. */
export const backupResultSchema = z
  .union([
    z.object({ ok: z.literal(true), at: z.string().datetime(), bytes: z.number().int().nonnegative(), name: z.string().max(40) }).strict(),
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
  if (r.ok) return { tone: "ok", text: `Last backup ${formatIst(new Date(r.at))}, ${formatBytes(r.bytes)}.` };
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
