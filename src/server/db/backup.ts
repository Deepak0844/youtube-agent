import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, cp, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type pg from "pg";
import { DEFAULT_DB_CONTAINER, backupDue, backupName, backupResultSchema, backupsToDelete, dumpPlan, extraDirProblem, type BackupResult } from "@/server/core/backup";
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
  /** Test seam: writes the database dump to this file. Default: pg_dump on PATH, else inside the database container. */
  dump?: (file: string) => Promise<void>;
  /** Test seam: use these tools (for example a given container) instead of looking for pg_dump or the dev container. */
  pgMode?: PgMode;
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

/** How Postgres' own tools are reached: on PATH (connection from the URL), or inside the database container (its own local login). No password is ever an argument. */
export type PgMode = { kind: "local"; env: Env } | { kind: "docker"; container: string; user: string; db: string };

/** pg_dump / pg_restore on PATH if present, else inside the running database container. Throws a plain sentence when neither is available. */
export async function choosePgMode(deps: { databaseUrl?: string; pgMode?: PgMode }): Promise<PgMode> {
  if (deps.pgMode) return deps.pgMode;
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
  return plan.kind === "local" ? { kind: "local", env: pgEnv(url) } : { kind: "docker", container, user, db: dbName };
}

/** Runs one Postgres tool with an optional file on stdin or stdout, or captured output (capped). Rejects with a plain error when it exits non-zero. */
export function runPgTool(mode: PgMode, tool: "pg_dump" | "pg_restore", args: string[], io: { stdinFile?: string; stdoutFile?: string; capture?: boolean; needsDb?: boolean } = {}): Promise<string> {
  const cmd = mode.kind === "local" ? tool : "docker";
  const full =
    mode.kind === "local"
      ? ["--no-password", ...(io.needsDb ? ["-d", mode.env.PGDATABASE ?? ""] : []), ...args]
      : ["exec", "-i", mode.container, tool, "-U", mode.user, ...(io.needsDb ? ["-d", mode.db] : []), ...args];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, full, { env: (mode.kind === "local" ? mode.env : { PATH: process.env.PATH }) as NodeJS.ProcessEnv, stdio: [io.stdinFile ? "pipe" : "ignore", io.stdoutFile || io.capture ? "pipe" : "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), DUMP_TIMEOUT_MS);
    let captured = "";
    if (io.stdinFile) {
      const input = createReadStream(io.stdinFile);
      input.on("error", () => child.kill());
      input.pipe(child.stdin!);
      child.stdin!.on("error", () => undefined); // the tool may exit before it has read everything
    }
    if (io.stdoutFile) {
      const out = createWriteStream(io.stdoutFile, { mode: 0o600 });
      child.stdout!.pipe(out);
      out.on("error", reject);
    } else if (io.capture) {
      child.stdout!.on("data", (d: Buffer) => {
        if (captured.length < 4 * 1024 * 1024) captured += d.toString("utf8");
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(captured);
      else reject(new Error(`${tool} exited with an error`));
    });
  });
}

/** pg_dump to a file, in whichever way the tools are reached. */
async function dumpDatabase(file: string, deps: BackupDeps, exec: NonNullable<BackupDeps["exec"]>): Promise<void> {
  if (deps.dump) return deps.dump(file);
  const mode = await choosePgMode(deps);
  if (mode.kind === "local" && !deps.pgMode) return exec("pg_dump", ["--format=custom", "--no-password", "--file", file], mode.env);
  await runPgTool(mode, "pg_dump", ["--format=custom", ...(mode.kind === "local" ? ["--file", file] : [])], mode.kind === "local" ? {} : { stdoutFile: file, needsDb: true });
}

/** Makes one backup folder. `prune: false` keeps every older one (a restore's safety backup must never delete the backup being restored). */
export async function backupNow(root: string, now: Date, deps: BackupDeps, opts: { prune?: boolean } = {}): Promise<{ name: string; bytes: number; pruned: number; dir: string }> {
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
    const old = opts.prune === false ? [] : backupsToDelete(await readdir(dir));
    for (const n of old) await rm(path.join(dir, n), { recursive: true, force: true });
    return { name, bytes, pruned: old.length, dir: target };
  } catch (e) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

const save = (db: pg.Pool, r: BackupResult) => setSessionSettings(db, [{ key: "backup.last_run", value: r }], async () => undefined);

const LOCK = "ytstudio.backup";

/** One backup at a time across every process (the Back up now button, the schedule, two workers). Returns null when another one holds the lock. */
async function withBackupLock<T>(db: pg.Pool, work: () => Promise<T>): Promise<T | null> {
  const client = await db.connect();
  try {
    const got = (await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [LOCK])).rows[0]?.ok === true;
    if (!got) return null;
    try {
      return await work();
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** The optional second copy of every backup (an external drive or another folder the owner names). Empty or unset = off. */
export async function extraBackupDir(db: pg.Pool): Promise<string> {
  const v = await getSetting(db, "backup.extra_dir");
  return typeof v === "string" ? v.trim() : "";
}

/** Disk checks for the extra folder: it exists, is a folder, and a file can be written in it. Fixed sentences only. */
async function extraDirDiskProblem(dir: string): Promise<string | null> {
  try {
    const real = await realpath(dir);
    if (!(await stat(real)).isDirectory()) return "That is not a folder.";
    await access(real, constants.W_OK);
    const probe = path.join(real, `.write-check-${process.pid}`);
    await writeFile(probe, "x", { mode: 0o600 });
    await rm(probe, { force: true });
    return null;
  } catch {
    return "That folder is not there or cannot be written to. Check the drive is plugged in.";
  }
}

/** Copies the finished backup folder into the extra folder and keeps only the newest 7 there too. Throws a plain reason on failure. */
async function copyToExtra(extra: string, root: string, from: string, name: string): Promise<void> {
  const problem = extraDirProblem(extra, root) ?? (await extraDirDiskProblem(extra));
  if (problem) throw new BackupError(problem);
  const real = await realpath(extra);
  await cp(from, path.join(real, name), { recursive: true, errorOnExist: false, force: true });
  for (const n of backupsToDelete(await readdir(real))) await rm(path.join(real, n), { recursive: true, force: true });
}

/**
 * Saves the extra-copy folder (empty = off). Session only: the caller has already passed requireOwner. It is checked before it is saved (a plain path that is
 * not a system folder or the app's own storage, that exists and can be written to), so a typo is refused now and not at 3 a.m. The path itself is never audited.
 */
export async function saveBackupExtraDir(db: pg.Pool, sessionId: string, raw: unknown, deps: { root?: string } = {}): Promise<{ ok: true; on: boolean } | { ok: false; error: string }> {
  if (typeof raw !== "string") return { ok: false, error: "That folder name is not usable." };
  const dir = raw.trim();
  if (dir !== "") {
    const problem = extraDirProblem(dir, deps.root ?? storageRoot()) ?? (await extraDirDiskProblem(dir));
    if (problem) return { ok: false, error: problem };
  }
  try {
    await setSessionSettings(db, [{ key: "backup.extra_dir", value: dir }], async () => undefined);
    await recordAudit(db, "backup.extra_dir_changed", { sessionId, on: dir !== "" });
    return { ok: true, on: dir !== "" };
  } catch {
    return { ok: false, error: "That could not be saved. Try again." };
  }
}

/**
 * Session or schedule (sessionId null = the schedule): the caller has already passed requireOwner, or is the worker's own timer. Never throws; the outcome is
 * the stored result. One at a time: when another backup is running this returns "already running" and stores nothing.
 */
export async function runBackup(db: pg.Pool, sessionId: string | null, deps: BackupDeps = {}): Promise<BackupResult> {
  const now = (deps.now ?? (() => new Date()))();
  const out = await withBackupLock(db, async (): Promise<BackupResult> => {
    let result: BackupResult;
    try {
      const root = deps.root ?? storageRoot();
      const r = await backupNow(root, now, deps);
      result = { ok: true, at: now.toISOString(), bytes: r.bytes, name: r.name };
      const extra = await extraBackupDir(db).catch(() => "");
      if (extra !== "") {
        try {
          await copyToExtra(extra, root, r.dir, r.name);
          result = { ...result, extra: "copied" };
        } catch {
          result = { ...result, extra: "failed" }; // the local backup is good; only the second copy failed
        }
      }
      await save(db, result);
      await recordAudit(db, "backup.completed", { sessionId, name: r.name, bytes: r.bytes, pruned: r.pruned, ...(result.ok && result.extra ? { extra: result.extra } : {}) });
      if (result.ok && result.extra === "failed") {
        await notifyTransition(db, { channels: {}, inAppOnly: true }, { event: "backup_failed", from: "ok", to: "backup_failed", transitionId: `backup-extra-${now.toISOString()}`, detail: "The extra copy of the backup failed. The backup itself is fine." }).catch(() => undefined);
      }
    } catch (e) {
      const cls = e instanceof Error ? e.name : "Error";
      console.error(JSON.stringify({ event: "backup.failed", error: cls }));
      result = { ok: false, at: now.toISOString(), error: reason(e) };
      await save(db, result).catch(() => undefined);
      await recordAudit(db, "backup.failed", { sessionId, reason: cls }).catch(() => undefined);
      await notifyTransition(db, { channels: {}, inAppOnly: true }, { event: "backup_failed", from: "ok", to: "backup_failed", transitionId: `backup-${now.toISOString()}`, detail: result.error }).catch(() => undefined);
    }
    return result;
  });
  return out ?? { ok: false, at: now.toISOString(), error: "A backup is already running. Try again in a few minutes." };
}

/** The worker's schedule: makes a backup when one is due (none yet, or the last is 6 hours old; an hour after a failure). Returns null when none was due. */
export async function scheduledBackupTick(db: pg.Pool, deps: BackupDeps = {}): Promise<BackupResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  if (!backupDue(await lastBackup(db), now)) return null;
  const r = await runBackup(db, null, deps);
  // "already running" stores nothing, so the next tick asks again; any other outcome is stored and spaces the next one.
  return r;
}

/** For the worker loop, which ticks often: asks the database at most every few minutes, never throws, never overlaps itself. */
export function throttledBackup(db: pg.Pool, opts: { everyMs?: number; now?: () => number; deps?: BackupDeps } = {}): () => Promise<void> {
  const every = opts.everyMs ?? 5 * 60_000;
  const clock = opts.now ?? Date.now;
  let last = -Infinity;
  let running = false;
  return async () => {
    const t = clock();
    if (running || t - last < every) return;
    last = t;
    running = true;
    try {
      await scheduledBackupTick(db, opts.deps ?? {});
    } catch {
      /* the next tick tries again */
    } finally {
      running = false;
    }
  };
}
