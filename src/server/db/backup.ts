import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { DEFAULT_DB_CONTAINER, backupName, backupResultSchema, backupsToDelete, dumpPlan, type BackupResult } from "@/server/core/backup";
import { recordAudit } from "@/server/db/audit";
import { notifyTransition } from "@/server/db/notify";
import { getSetting, setSessionSettings } from "@/server/db/settings";
import { storageRoot } from "@/server/storage/paths";

// Back up now: a Postgres dump plus an archive of the storage folder, kept under <storage>/backups (newest 7 stay).
// Tools run through execFile with an argument array (no shell). The database password goes only in the child's environment,
// never on a command line. Stored and audited errors are fixed sentences: tool output can carry a connection string.
const run = promisify(execFile);
const BACKUPS_DIR = "backups";
const DUMP_TIMEOUT_MS = 30 * 60_000;

type Env = Record<string, string | undefined>;

export interface BackupDeps {
  /** Test seam. Default runs pg_dump / tar. */
  exec?: (cmd: string, args: string[], env: Env) => Promise<void>;
  root?: string;
  now?: () => Date;
  databaseUrl?: string;
}

const defaultExec: NonNullable<BackupDeps["exec"]> = async (cmd, args, env) => {
  await run(cmd, args, { env: env as NodeJS.ProcessEnv, timeout: DUMP_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true });
};

class BackupError extends Error {}

/** Connection parts for pg_dump as PG* variables, from the migration/owner URL when set, else the app URL. */
function pgEnv(url: string | undefined): Env {
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    throw new BackupError("The database address is not set.");
  }
  const env: Env = { PATH: process.env.PATH, PGHOST: u.hostname, PGPORT: u.port || "5432", PGDATABASE: decodeURIComponent(u.pathname.slice(1)) };
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  return env;
}

async function sizeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

function reason(e: unknown): string {
  if (e instanceof BackupError) return e.message;
  const code = (e as { code?: unknown }).code;
  if (code === "ENOENT") return "A needed program (pg_dump or tar) is not installed on this machine.";
  if (code === "ENOSPC") return "The disk is full.";
  return "The dump or the archive did not finish. Check the server log for the error class.";
}

export async function lastBackup(db: pg.Pool): Promise<BackupResult | null> {
  const parsed = backupResultSchema.safeParse(await getSetting(db, "backup.last_run"));
  return parsed.success ? parsed.data : null;
}

const ok = (cmd: string, args: string[]) => run(cmd, args, { timeout: 10_000, windowsHide: true }).then((r) => r.stdout, () => null);

/** pg_dump on PATH if present, else pg_dump inside the database container, streamed to the file. No password is ever an argument. */
async function dumpDatabase(file: string, deps: BackupDeps, exec: NonNullable<BackupDeps["exec"]>): Promise<void> {
  const url = deps.databaseUrl ?? process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  const container = process.env.BACKUP_DB_CONTAINER || DEFAULT_DB_CONTAINER;
  const pgDump = (await ok("pg_dump", ["--version"])) !== null;
  const containerRunning = !pgDump && (await ok("docker", ["inspect", "-f", "{{.State.Running}}", container]))?.trim() === "true";
  // The container's own login: its POSTGRES_USER / POSTGRES_DB (read with printenv, no shell).
  const user = containerRunning ? (await ok("docker", ["exec", container, "printenv", "POSTGRES_USER"]))?.trim() || "postgres" : "postgres";
  let dbName = user;
  try {
    dbName = decodeURIComponent(new URL(url ?? "").pathname.slice(1)) || user;
  } catch {
    /* container default */
  }
  const plan = dumpPlan({ pgDump, containerRunning }, { container, user, db: dbName });
  if (plan.kind === "none") throw new BackupError(plan.message);
  if (plan.kind === "local") return exec("pg_dump", ["--format=custom", "--no-password", "--file", file], pgEnv(url));
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file, { mode: 0o600 });
    const child = spawn("docker", plan.args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), DUMP_TIMEOUT_MS);
    child.stdout.pipe(out);
    child.on("error", reject);
    out.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) out.end(resolve);
      else reject(new Error("dump exited with an error"));
    });
  });
}

async function backupNow(root: string, now: Date, deps: BackupDeps): Promise<{ name: string; bytes: number; pruned: number }> {
  const exec = deps.exec ?? defaultExec;
  const dir = path.join(root, BACKUPS_DIR);
  const name = backupName(now);
  const target = path.join(dir, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  try {
    const dump = path.join(target, "db.dump");
    await dumpDatabase(dump, deps, exec);
    // Everything in the storage folder except the backups folder itself.
    const members = (await readdir(root)).filter((n) => n !== BACKUPS_DIR);
    const archive = path.join(target, "storage.tar.gz");
    if (members.length > 0) await exec("tar", ["-czf", archive, "-C", root, "--", ...members], { PATH: process.env.PATH });
    const bytes = (await sizeOf(dump)) + (await sizeOf(archive));
    const old = backupsToDelete(await readdir(dir));
    for (const n of old) await rm(path.join(dir, n), { recursive: true, force: true });
    return { name, bytes, pruned: old.length };
  } catch (e) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

const save = (db: pg.Pool, r: BackupResult) => setSessionSettings(db, [{ key: "backup.last_run", value: r }], async () => undefined);

/** Session only: the caller has already passed requireOwner. Never throws; the outcome is the stored result. */
export async function runBackup(db: pg.Pool, sessionId: string, deps: BackupDeps = {}): Promise<BackupResult> {
  const now = (deps.now ?? (() => new Date()))();
  let result: BackupResult;
  try {
    const r = await backupNow(deps.root ?? storageRoot(), now, deps);
    result = { ok: true, at: now.toISOString(), bytes: r.bytes, name: r.name };
    await save(db, result);
    await recordAudit(db, "backup.completed", { sessionId, name: r.name, bytes: r.bytes, pruned: r.pruned });
  } catch (e) {
    const cls = e instanceof Error ? e.name : "Error";
    console.error(JSON.stringify({ event: "backup.failed", error: cls }));
    result = { ok: false, at: now.toISOString(), error: reason(e) };
    await save(db, result).catch(() => undefined);
    await recordAudit(db, "backup.failed", { sessionId, reason: cls }).catch(() => undefined);
    // In-app notification row only: the web process has no desktop or webhook sender (those plug in on the worker side).
    await notifyTransition(db, { channels: {}, inAppOnly: true }, { event: "backup_failed", from: "ok", to: "backup_failed", transitionId: `backup-${now.toISOString()}`, detail: result.error }).catch(() => undefined);
  }
  return result;
}
