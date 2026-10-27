import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { atomic, toNumber, type Claim } from "@/server/db/stages";
import { attemptDir, normalizeRelPath, safeJoin, storageRoot, videoPath } from "./paths";

type Db = pg.Pool | pg.PoolClient;

const isErr = (e: unknown, code: string): boolean => (e as NodeJS.ErrnoException)?.code === code;
const stat = (p: string) => lstat(p).catch((e) => (isErr(e, "ENOENT") || isErr(e, "ENOTDIR") ? null : Promise.reject(e)));

export const PROMOTE_MARKER = ".promote-marker.json";
const RESERVED = /^\.(promote-|backup-)/;

/** true: the real path is exactly root + parts (no symlink on the way); false: it resolves elsewhere; null: absent. */
async function realIs(root: string, parts: string[]): Promise<boolean | null> {
  try {
    return (await realpath(path.join(root, ...parts))) === path.join(await realpath(root), ...parts);
  } catch (e) {
    if (isErr(e, "ENOENT") || isErr(e, "ENOTDIR")) return null;
    throw e;
  }
}

/** Walks `parts` below `base` with lstat at EVERY level: a symlink anywhere, or a wrong kind of entry, is an error. */
async function sourceKind(base: string, parts: string[]): Promise<"file" | "missing"> {
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]!);
    const st = await stat(cur);
    if (!st) return "missing";
    if (st.isSymbolicLink()) throw new Error("promoteAttempt: symlink inside the attempt folder");
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) throw new Error("promoteAttempt: source is not a regular file");
  }
  return "file";
}

async function readMarker(file: string, claim: Claim): Promise<string[]> {
  const st = await stat(file);
  if (!st) return [];
  if (!st.isFile()) throw new Error("promoteAttempt: marker is not a regular file");
  try {
    const m = JSON.parse(await readFile(file, "utf8")) as { stageRunId?: unknown; fence?: unknown; files?: unknown };
    if (m.stageRunId !== claim.stageRunId || m.fence !== claim.fence || !Array.isArray(m.files)) return [];
    return m.files.filter((f): f is string => typeof f === "string");
  } catch {
    return [];
  }
}

async function writeMarker(file: string, claim: Claim, files: string[]): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ stageRunId: claim.stageRunId, fence: claim.fence, files }));
  await rename(tmp, file);
}

/**
 * Moves finished files from this attempt's folder into the video folder, only while the caller still owns the stage.
 *
 * PRECONDITION: the process that wrote the attempt folder (render container, child tool) is dead. Checks and moves are
 * not atomic against a live writer; the lease and fence only stop OTHER workers, not a sandbox still running for this one.
 *
 * The stage row is locked (`for update`) and re-checked INSIDE the transaction: running, same fence, same worker, lease
 * not expired (database clock), no cancel requested. A worker that lost any of these gets `false` and its files stay in
 * its attempt folder, where the sweep removes them. Video id and stage run id come from that row, never from the caller.
 * `files` are paths relative to the attempt folder (e.g. "final.mp4", "frames/001.png").
 *
 * All checks run before the first move. The attempt folder and the video folder must be real folders (no symlink on
 * their path), every source must be a regular file reached without crossing a symlink at ANY level (a sandbox could
 * plant one to pull another video's files), and every destination must stay inside the storage root. A source that is
 * gone counts as already promoted ONLY if a marker written by this same claim (stage run id + fence) lists it and the
 * destination is a regular file; an old run's file at the destination is never accepted. Overwritten destination files
 * are first moved into a backup folder inside the attempt folder, so a failure half way restores both the moved files and
 * the files they replaced. After each rename the destination is re-checked to be a regular file. Throws (not false) on
 * bad input or a missing file: those are bugs, not staleness.
 */
export async function promoteAttempt(db: Db, claim: Claim, files: string[], opts: { root?: string } = {}): Promise<boolean> {
  const root = opts.root ?? storageRoot();
  if (!Array.isArray(files) || files.length === 0) throw new Error("promoteAttempt: no files given");
  const seen = new Set<string>();
  for (const f of files) {
    if (normalizeRelPath(f) === null || RESERVED.test(f.split("/")[0]!)) throw new Error("promoteAttempt: invalid file name");
    if (seen.has(f)) throw new Error("promoteAttempt: duplicate file name");
    seen.add(f);
  }

  return atomic(db, async (q) => {
    const { rows } = await q.query<{ video_id: string; fence: string; status: string; lease_owner: string | null; live: boolean | null; cancel_requested: boolean }>(
      "select video_id, fence, status, lease_owner, (lease_until > clock_timestamp()) as live, cancel_requested from stage_runs where id = $1 for update",
      [claim.stageRunId],
    );
    const row = rows[0];
    if (!row || row.status !== "running" || toNumber(row.fence) !== claim.fence || row.lease_owner !== claim.workerId) return false;
    if (row.live !== true || row.cancel_requested) return false;

    const src = attemptDir(root, row.video_id, claim.stageRunId, claim.fence);
    if ((await realIs(root, ["videos", row.video_id])) === false) throw new Error("promoteAttempt: video folder is not a plain folder");
    const attemptStat = await stat(src);
    if (attemptStat && (!attemptStat.isDirectory() || (await realIs(root, ["videos", row.video_id, path.basename(src)])) !== true)) {
      throw new Error("promoteAttempt: attempt folder is not a plain folder");
    }
    const markerFile = path.join(src, PROMOTE_MARKER);
    const markerFiles = attemptStat ? await readMarker(markerFile, claim) : [];

    const plan: { from: string; to: string; backup?: string }[] = [];
    for (const f of files) {
      const parts = f.split("/");
      const to = await safeJoin(root, "videos", row.video_id, ...parts);
      const toStat = await stat(to);
      if (toStat && !toStat.isFile()) throw new Error("promoteAttempt: destination is not a regular file");
      const kind = attemptStat ? await sourceKind(src, parts) : "missing";
      if (kind === "file") {
        plan.push({ from: path.join(src, ...parts), to });
      } else if (!(toStat && markerFiles.includes(f))) {
        throw new Error("promoteAttempt: a file to promote does not exist");
      }
    }
    if (plan.length === 0) return true;

    const backupDir = path.join(src, `.backup-${randomUUID()}`);
    const touched: typeof plan = [];
    try {
      await writeMarker(markerFile, claim, [...new Set([...markerFiles, ...files])]);
      for (const step of plan) {
        await mkdir(path.dirname(step.to), { recursive: true });
        await safeJoin(root, ...path.relative(root, step.to).split(path.sep)); // re-check after the folders exist
        if (await stat(step.to)) {
          await mkdir(backupDir, { recursive: true });
          step.backup = path.join(backupDir, String(touched.length));
          await rename(step.to, step.backup);
        }
        touched.push(step);
        await rename(step.from, step.to);
        if (!(await stat(step.to))?.isFile()) throw new Error("promoteAttempt: promoted file is not a regular file");
      }
    } catch (err) {
      for (const step of touched.reverse()) {
        if ((await stat(step.to)) && !(await stat(step.from))) await rename(step.to, step.from).catch(() => undefined);
        if (step.backup) await rename(step.backup, step.to).catch(() => undefined);
      }
      if (markerFiles.length > 0) await writeMarker(markerFile, claim, markerFiles).catch(() => undefined);
      else await rm(markerFile, { force: true }).catch(() => undefined);
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTEMPT = /^attempt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([1-9][0-9]{0,14})$/;

/**
 * Deletes attempt folders whose fence was lost: the folder's stage run exists (same video) and is on a higher fence.
 * Keeps the current fence's folder, folders whose stage run is unknown, anything that does not look like an attempt
 * folder, and symlinks (never followed). Promoted files are not inside attempt folders and are never touched. Returns how
 * many folders were removed. A folder that cannot be removed (permissions) is skipped, not fatal.
 */
export async function sweepLostAttempts(db: Pick<pg.Pool, "query">, opts: { root?: string } = {}): Promise<number> {
  const root = opts.root ?? storageRoot();
  const videosDir = path.join(root, "videos");
  let videos: string[];
  try {
    videos = await readdir(videosDir);
  } catch (e) {
    if (isErr(e, "ENOENT") || isErr(e, "ENOTDIR")) return 0;
    throw e;
  }
  let removed = 0;
  for (const videoId of videos) {
    if (!UUID.test(videoId)) continue;
    const vdir = videoPath(root, videoId);
    if (!(await stat(vdir))?.isDirectory()) continue;
    for (const entry of await readdir(vdir)) {
      const m = ATTEMPT.exec(entry);
      if (!m) continue;
      const dir = path.join(vdir, entry);
      if (!(await stat(dir))?.isDirectory()) continue; // lstat: a symlink is not a directory here
      const fence = Number(m[2]);
      const { rows } = await db.query<{ fence: string }>("select fence from stage_runs where id = $1 and video_id = $2", [m[1], videoId]);
      if (rows.length === 0 || toNumber(rows[0]!.fence) <= fence) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed++;
      } catch {
        /* leave it for the next sweep */
      }
    }
  }
  return removed;
}
