import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import { atomic, toNumber, type Claim } from "@/server/db/stages";
import { attemptDir, normalizeRelPath, safeJoin, storageRoot, videoPath } from "./paths";

type Db = pg.Pool | pg.PoolClient;

const isErr = (e: unknown, code: string): boolean => (e as NodeJS.ErrnoException)?.code === code;
const stat = (p: string) => lstat(p).catch((e) => (isErr(e, "ENOENT") || isErr(e, "ENOTDIR") ? null : Promise.reject(e)));

/**
 * Moves finished files from this attempt's folder into the video folder, only while the caller still owns the stage.
 *
 * The stage row is locked (`for update`) and re-checked INSIDE the transaction: status running, same fence, same worker.
 * A worker that lost its lease (higher fence, reconciled, committed, cancelled) gets `false` and its files stay in its
 * attempt folder, where the sweep removes them. The video id, stage name and fence come from that row, never from the
 * caller. `files` are paths relative to the attempt folder (e.g. "final.mp4", "frames/001.png").
 *
 * All checks run before the first move: every source must be a regular file (never a symlink, a sandbox could plant
 * one) and every destination must stay inside the storage root. A source that is gone but whose destination is already
 * there counts as promoted, so a retry after a crash succeeds. If a rename fails half way, the earlier moves are undone
 * best effort and the error is thrown. Throws (not false) on bad input or a missing file: those are bugs, not staleness.
 */
export async function promoteAttempt(db: Db, claim: Claim, files: string[], opts: { root?: string } = {}): Promise<boolean> {
  const root = opts.root ?? storageRoot();
  if (!Array.isArray(files) || files.length === 0) throw new Error("promoteAttempt: no files given");
  const seen = new Set<string>();
  for (const f of files) {
    if (normalizeRelPath(f) === null) throw new Error("promoteAttempt: invalid file name");
    if (seen.has(f)) throw new Error("promoteAttempt: duplicate file name");
    seen.add(f);
  }

  return atomic(db, async (q) => {
    const { rows } = await q.query<{ video_id: string; name: string; fence: string; status: string; lease_owner: string | null }>(
      "select video_id, name, fence, status, lease_owner from stage_runs where id = $1 for update",
      [claim.stageRunId],
    );
    const row = rows[0];
    if (!row || row.status !== "running" || toNumber(row.fence) !== claim.fence ||row.lease_owner !== claim.workerId) return false;

    const src = attemptDir(root, row.video_id, row.name, claim.fence);
    const attemptRel = path.relative(path.join(root, "videos", row.video_id), src);
    const plan: { from: string; to: string; done: boolean }[] = [];
    const attemptStat = await stat(src);
    if (attemptStat && !attemptStat.isDirectory()) throw new Error("promoteAttempt: attempt folder is not a plain folder");
    for (const f of files) {
      const parts = f.split("/");
      const to = await safeJoin(root, "videos", row.video_id, ...parts);
      const toStat = await stat(to);
      if (toStat?.isDirectory()) throw new Error("promoteAttempt: destination is a folder");
      const from = attemptStat ? await safeJoin(root, "videos", row.video_id, attemptRel, ...parts) : null;
      const fromStat = from ? await stat(from) : null;
      if (fromStat) {
        if (!fromStat.isFile()) throw new Error("promoteAttempt: source is not a regular file");
        plan.push({ from: from!, to, done: false });
      } else if (toStat?.isFile()) {
        continue; // already promoted by an earlier call
      } else {
        throw new Error("promoteAttempt: a file to promote does not exist");
      }
    }

    const moved: typeof plan = [];
    try {
      for (const step of plan) {
        await mkdir(path.dirname(step.to), { recursive: true });
        await safeJoin(root, ...path.relative(root, step.to).split(path.sep)); // re-check after the folders exist
        await rename(step.from, step.to);
        moved.push(step);
      }
    } catch (err) {
      for (const step of moved.reverse()) await rename(step.to, step.from).catch(() => undefined);
      throw err;
    }
    return true;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ATTEMPT = /^attempt-([a-z][a-z0-9_]{0,63})-([1-9][0-9]{0,14})$/;

/**
 * Deletes attempt folders whose fence was lost: the stage has rows for that video and name and every one of them is on a
 * higher fence than the folder. Keeps the current fence's folder, folders with no stage row at all, anything that does not
 * look like an attempt folder, and symlinks (never followed). Promoted files are not inside attempt folders and are never
 * touched. Returns how many folders were removed. A folder that cannot be removed (permissions) is skipped, not fatal.
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
      const { rows } = await db.query<{ fence: string }>("select fence from stage_runs where video_id = $1 and name = $2", [videoId, m[1]]);
      if (rows.length === 0 || !rows.every((r) => toNumber(r.fence) > fence)) continue;
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
