import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { formatBytes, isBackupName, parseMigrationNames, pickBackup, schemaProblem } from "@/server/core/backup";
import { recordAudit } from "@/server/db/audit";
import { backupNow, choosePgMode, runPgTool, type BackupDeps } from "@/server/db/backup";
import { storageRoot } from "@/server/storage/paths";

// Restore a backup made by Back up now or the schedule: the database dump and the storage archive (db.dump and storage.tar.gz in one folder).
// Used by the command line (scripts/backup-restore.ts) only: there is no restore button, on purpose. It looks first and changes nothing unless told to
// (--yes), refuses while the app or the worker is connected to the database, refuses a backup from a NEWER version of the app, checks that the dump and the
// archive can be read, and makes a safety backup of the current state first, so a restore can itself be undone. Messages are fixed sentences: tool output can
// carry a connection string.
const run = promisify(execFile);
const BACKUPS_DIR = "backups";
const MAX_LIST = 64 * 1024 * 1024;

export interface RestoreDeps extends BackupDeps {
  /** The database role the app and the worker connect as (default ytstudio_app). Connected sessions of this role stop a restore. */
  appRole?: string;
  /** The folder holding this app's migration files (default: next to this file). */
  migrationsDir?: string;
}

export interface BackupListItem {
  name: string;
  /** ISO time from the folder name (UTC) */
  at: string;
  bytes: number;
  hasStorage: boolean;
}

/** "backup-20261107T083005Z" -> "2026-11-07T08:30:05.000Z" */
export function backupTime(name: string): string {
  const m = /^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : "";
}

const isFile = async (f: string): Promise<number | null> => {
  const s = await lstat(f).catch(() => null);
  return s && s.isFile() ? s.size : null; // a plain file only: a symlink is not followed
};

/** The backups under <storage>/backups that have a readable-looking dump, newest first. */
export async function listBackups(root: string = storageRoot()): Promise<BackupListItem[]> {
  const dir = path.join(root, BACKUPS_DIR);
  const names = (await readdir(dir).catch(() => [] as string[])).filter(isBackupName).sort().reverse();
  const out: BackupListItem[] = [];
  for (const name of names) {
    const dump = await isFile(path.join(dir, name, "db.dump"));
    if (dump === null) continue;
    const storage = await isFile(path.join(dir, name, "storage.tar.gz"));
    out.push({ name, at: backupTime(name), bytes: dump + (storage ?? 0), hasStorage: storage !== null });
  }
  return out;
}

export const describeListItem = (b: BackupListItem): string => `${b.name}  ${formatBytes(b.bytes)}  ${b.hasStorage ? "database + files" : "database only"}`;

export type RestoreReport = { ok: true; dryRun: boolean; steps: string[]; safetyCopy?: string } | { ok: false; reason: string; steps: string[] };

/** Archive member names that are not plain relative paths inside the folder: absolute, or with a .. part. */
export function unsafeArchiveNames(listing: string): string[] {
  return listing
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((n) => n.startsWith("/") || n.split("/").some((p) => p === ".."));
}

async function tarOut(args: string[]): Promise<string> {
  return (await run("tar", args, { maxBuffer: MAX_LIST, timeout: 30 * 60_000, windowsHide: true, env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv })).stdout;
}

/**
 * Restores one backup. Without `yes` it only checks and reports what it would do (a dry run). `db` must connect as the migration owner role (not the app
 * role), because the app role's own connections are what stops a restore. Never throws for an expected refusal: the reason is in the report.
 */
export async function restoreBackup(db: pg.Pool, opts: { name: string; yes: boolean; skipSafetyCopy?: boolean }, deps: RestoreDeps = {}): Promise<RestoreReport> {
  const steps: string[] = [];
  const refuse = (reason: string): RestoreReport => ({ ok: false, reason, steps });
  const root = deps.root ?? storageRoot();
  const now = (deps.now ?? (() => new Date()))();

  const dir = path.join(root, BACKUPS_DIR);
  const pick = pickBackup(await readdir(dir).catch(() => [] as string[]), opts.name);
  if (!pick.ok) return refuse(pick.reason);
  const folder = path.join(dir, pick.name);
  const dump = path.join(folder, "db.dump");
  const archive = path.join(folder, "storage.tar.gz");
  if ((await isFile(dump)) === null) return refuse(`${pick.name} has no database dump (db.dump), so it cannot be restored.`);
  const hasArchive = (await isFile(archive)) !== null;
  steps.push(`Backup ${pick.name}: ${hasArchive ? "database and files" : "database only"}.`);

  let mode;
  try {
    mode = await choosePgMode(deps);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : "Postgres' tools (pg_restore) are not available.");
  }

  // 1. The dump and the archive can be read, and the archive stays inside the storage folder.
  try {
    const toc = await runPgTool(mode, "pg_restore", ["--list"], { stdinFile: dump, capture: true });
    if (!/TABLE DATA|TABLE /.test(toc)) return refuse("The database dump is empty or not a database backup. Nothing was changed.");
  } catch {
    return refuse("The database dump cannot be read (damaged or not a backup). Nothing was changed.");
  }
  steps.push("The database dump can be read.");
  if (hasArchive) {
    let listing: string;
    try {
      listing = await tarOut(["-tzf", archive]);
    } catch {
      return refuse("The files archive cannot be read (damaged). Nothing was changed.");
    }
    if (unsafeArchiveNames(listing).length > 0) return refuse("The files archive contains paths outside the storage folder, so it will not be unpacked. Nothing was changed.");
    steps.push("The files archive can be read and stays inside the storage folder.");
  }

  // 2. The backup is not from a NEWER version of the app.
  let dumpMigrations: string[];
  try {
    dumpMigrations = parseMigrationNames(await runPgTool(mode, "pg_restore", ["--data-only", "--table=schema_migrations", "--file=-"], { stdinFile: dump, capture: true }));
  } catch {
    return refuse("The database version of this backup could not be read. Nothing was changed.");
  }
  const migrationsDir = deps.migrationsDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const appMigrations = (await readdir(migrationsDir).catch(() => [] as string[])).filter((n) => n.endsWith(".sql"));
  const problem = schemaProblem(dumpMigrations, appMigrations);
  if (problem) return refuse(problem);
  steps.push("The backup is from this version of the app or an older one.");

  // 3. Nothing is connected: the app and the worker must be stopped, or they would write into a database that is being replaced.
  const role = deps.appRole ?? "ytstudio_app";
  const n = Number((await db.query("select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and usename = $1", [role])).rows[0]?.n ?? 0);
  if (n > 0) return refuse(`The app or the worker is still connected to the database (${n} connection${n === 1 ? "" : "s"}). Stop both first, then run this again. Nothing was changed.`);
  steps.push("The app and the worker are stopped.");

  if (!opts.yes) {
    steps.push(`Dry run: nothing was changed. To restore ${pick.name}${opts.skipSafetyCopy ? "" : " (a safety backup of the current state is made first)"}, run it again with --yes.`);
    return { ok: true, dryRun: true, steps };
  }

  // 4. A safety backup of the current state first, so this restore can be undone.
  let safetyCopy: string | undefined;
  if (!opts.skipSafetyCopy) {
    try {
      const safe = await backupNow(root, now, deps, { prune: false }); // never prune here: the backup being restored may be the oldest one
      safetyCopy = safe.name;
      steps.push(`Safety backup of the current state made: ${safe.name}.`);
    } catch {
      return refuse("The safety backup of the current state could not be made, so nothing was restored. Fix that (disk space, Postgres tools) or, if the current state is already lost, run again with --skip-safety-copy.");
    }
  }

  // 5. The database, in one transaction: if anything fails it is left exactly as it was.
  try {
    await runPgTool(mode, "pg_restore", ["--clean", "--if-exists", "--single-transaction", "--exit-on-error"], { stdinFile: dump, needsDb: true });
  } catch {
    return refuse(`The database restore failed and was rolled back, so the database is as it was.${safetyCopy ? ` Safety backup: ${safetyCopy}.` : ""}`);
  }
  steps.push("The database was restored.");

  // 6. The files: unpacked beside, then swapped in, so a failed unpack changes nothing.
  if (hasArchive) {
    const tmp = path.join(root, `.restore-${now.getTime()}`);
    try {
      await mkdir(tmp, { mode: 0o700 });
      await tarOut(["-xzf", archive, "-C", tmp]);
      for (const entry of await readdir(root)) if (entry !== BACKUPS_DIR && entry !== path.basename(tmp)) await rm(path.join(root, entry), { recursive: true, force: true });
      for (const entry of await readdir(tmp)) await rename(path.join(tmp, entry), path.join(root, entry));
      steps.push("The files were restored.");
    } catch {
      return refuse(`The database was restored, but unpacking the files failed.${safetyCopy ? ` The state from before is in ${safetyCopy}.` : ""} Fix the cause and run the restore again.`);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    steps.push("This backup has no files archive, so the storage folder was left as it is.");
  }
  await recordAudit(db, "backup.restored", { name: pick.name, safetyCopy: safetyCopy ?? null }).catch(() => undefined);
  steps.push("Done. Start the app and the worker again.");
  return { ok: true, dryRun: false, steps, ...(safetyCopy ? { safetyCopy } : {}) };
}
