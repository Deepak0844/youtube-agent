import { lstat, readdir, rm } from "node:fs/promises";
import type pg from "pg";
import { recordAudit } from "./audit";
import { loadAssetDays } from "./asset-settings";
import { trashAssets } from "./assets";
import { safeJoin } from "@/server/storage/paths";

// Asset retention: some days after a video was uploaded to YouTube (setting assets.retention_days), its working files are
// removed. Kept: the final video file(s), anything a Keep switch protects, and assets the owner uploaded himself (source = 'upload'). Pictures from
// the library go to the asset trash (restorable for the trash window), only when no other video uses them. Everything on disk
// is reached through safeJoin under the storage root, and nothing outside <root>/videos/<id>/ is ever touched.
// TODO Phase 9: the importer must add an 'imported' source marker and this query must exclude it too (today only 'upload' is protected).
// Audit rows carry counts and bytes only, never a path.

export type RetentionBy = { kind: "session"; sessionId: string } | { kind: "worker" };
export interface RetentionItem {
  videoId: string;
  topic: string;
  files: number;
  bytes: number;
  assets: number;
  assetBytes: number;
}
export interface RetentionPlan {
  days: number;
  items: RetentionItem[];
  files: number;
  bytes: number;
  assets: number;
  assetBytes: number;
}

type Found = { rels: string[]; bytes: number; assetIds: string[]; assetBytes: number };

async function sizeOf(abs: string): Promise<number> {
  const st = await lstat(abs).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size; // a symlink is removed as a link, its target is never read
  let total = 0;
  for (const n of await readdir(abs).catch(() => [])) total += await sizeOf(`${abs}/${n}`);
  return total;
}

async function collect(db: pg.Pool, root: string, videoId: string): Promise<Found> {
  const own = `videos/${videoId}/`;
  const content = await db.query<{ kind: string; file_path: string }>("select kind, file_path from video_content where video_id = $1 and file_path is not null", [videoId]);
  const finals = new Set(content.rows.filter((r) => r.kind === "video").map((r) => r.file_path));
  const rels = new Set<string>();
  for (const r of content.rows) if (r.kind !== "video" && r.file_path.startsWith(own) && !finals.has(r.file_path) && ![...finals].some((f) => f.startsWith(`${r.file_path}/`))) rels.add(r.file_path);
  // scratch folders of finished stage attempts, unless a final file lives inside one
  const dir = await safeJoin(root, "videos", videoId).catch(() => null);
  const names = dir ? await readdir(dir).catch(() => []) : [];
  for (const n of names) {
    if (!n.startsWith("attempt-")) continue;
    const rel = `${own}${n}`;
    if ([...finals].some((f) => f.startsWith(`${rel}/`))) continue;
    rels.add(rel);
  }
  let bytes = 0;
  const present: string[] = [];
  for (const rel of rels) {
    try {
      const abs = await safeJoin(root, ...rel.split("/"));
      if (!(await lstat(abs).catch(() => null))) continue;
      bytes += await sizeOf(abs);
      present.push(rel);
    } catch {
      // a path that is not safe is never touched
    }
  }
  const assets = await db.query<{ id: string; bytes: string }>(
    `select a.id, a.bytes::text as bytes from video_assets va join assets a on a.id = va.asset_id
      where va.video_id = $1 and a.deleted_at is null and not a.keep and a.source <> 'upload'
        and not exists (select 1 from video_assets o where o.asset_id = a.id and o.video_id <> $1)`,
    [videoId],
  );
  return { rels: present, bytes, assetIds: assets.rows.map((a) => a.id), assetBytes: assets.rows.reduce((s, a) => s + Number(a.bytes), 0) };
}

/** Videos whose upload finished at least `days` ago and that have no other upload still in flight or failed and no step queued or running. */
async function dueVideos(db: pg.Pool, days: number): Promise<Array<{ id: string; topic: string }>> {
  const { rows } = await db.query<{ id: string; topic: string }>(
    `select v.id, v.topic from videos v
      where exists (select 1 from uploads u where u.video_id = v.id and u.status = 'uploaded' and u.finished_at <= clock_timestamp() - make_interval(days => $1))
        and not exists (select 1 from uploads x where x.video_id = v.id and x.status <> 'uploaded')
        and not exists (select 1 from stage_runs s where s.video_id = v.id and s.status in ('queued', 'running'))
      order by v.created_at, v.id`,
    [days],
  );
  return rows;
}

/** Dry run: what a clean-up would remove right now. Changes nothing. */
export async function planRetention(db: pg.Pool, root: string): Promise<RetentionPlan> {
  const { retentionDays: days } = await loadAssetDays(db);
  const items: RetentionItem[] = [];
  for (const v of await dueVideos(db, days)) {
    const f = await collect(db, root, v.id);
    if (f.rels.length === 0 && f.assetIds.length === 0) continue;
    items.push({ videoId: v.id, topic: v.topic, files: f.rels.length, bytes: f.bytes, assets: f.assetIds.length, assetBytes: f.assetBytes });
  }
  const sum = (k: "files" | "bytes" | "assets" | "assetBytes") => items.reduce((s, i) => s + i[k], 0);
  return { days, items, files: sum("files"), bytes: sum("bytes"), assets: sum("assets"), assetBytes: sum("assetBytes") };
}

/** The real clean-up: re-evaluates every video at this moment (never trusts an earlier dry run), then removes. */
export async function runRetention(db: pg.Pool, root: string, by: RetentionBy, opts: { afterList?: () => Promise<void> } = {}): Promise<RetentionPlan> {
  const { retentionDays: days } = await loadAssetDays(db);
  const done: RetentionItem[] = [];
  const due = await dueVideos(db, days);
  await opts.afterList?.(); // test seam: lets a test change the world between the list and the per-video guard
  for (const v of due) {
    // Lock the video row and re-check the guard right now: a step queued after the list was built must win.
    const lock = await db.connect();
    try {
      await lock.query("begin");
      if (!(await guardOk(lock, v.id))) {
        await lock.query("rollback");
        continue;
      }
      await cleanOne(db, root, v, by, done);
      await lock.query("commit");
    } catch {
      await lock.query("rollback").catch(() => undefined);
    } finally {
      lock.release();
    }
  }
  const sum = (k: "files" | "bytes" | "assets" | "assetBytes") => done.reduce((s, i) => s + i[k], 0);
  return { days, items: done, files: sum("files"), bytes: sum("bytes"), assets: sum("assets"), assetBytes: sum("assetBytes") };
}

/** Takes the video row lock (skipping if someone holds it) and re-proves nothing is queued, running or unfinished. */
async function guardOk(q: pg.PoolClient, videoId: string): Promise<boolean> {
  const row = await q.query("select id from videos where id = $1 for update skip locked", [videoId]);
  if (row.rowCount === 0) return false;
  const bad = await q.query(
    `select 1 where exists (select 1 from stage_runs s where s.video_id = $1 and s.status in ('queued', 'running'))
        or exists (select 1 from uploads x where x.video_id = $1 and x.status <> 'uploaded')`,
    [videoId],
  );
  return bad.rowCount === 0;
}

async function cleanOne(db: pg.Pool, root: string, v: { id: string; topic: string }, by: RetentionBy, done: RetentionItem[]): Promise<void> {
  {
    const f = await collect(db, root, v.id);
    let files = 0;
    let bytes = 0;
    for (const rel of f.rels) {
      try {
        const abs = await safeJoin(root, ...rel.split("/")); // re-proved right before deleting
        const size = await sizeOf(abs);
        await rm(abs, { recursive: true, force: true });
        files++;
        bytes += size;
      } catch {
        // leave it: a failed removal is retried by the next run
      }
    }
    const trashed = f.assetIds.length ? (await trashAssets(db, f.assetIds, false)).trashed : [];
    if (files === 0 && trashed.length === 0) return;
    const assetBytes = trashed.length === f.assetIds.length ? f.assetBytes : 0;
    await recordAudit(db, "retention.cleaned", { videoId: v.id, by: by.kind, sessionId: by.kind === "session" ? by.sessionId : null, files, bytes, assetsTrashed: trashed.length, assetBytes });
    done.push({ videoId: v.id, topic: v.topic, files, bytes, assets: trashed.length, assetBytes });
  }
}

/** Worker hook: runs a clean-up at most once per `everyMs` (default 6 h) using the injected clock; errors never reach the caller. */
export function throttledRetention(db: pg.Pool, root: string, opts: { everyMs?: number; now?: () => number } = {}): () => Promise<void> {
  const every = opts.everyMs ?? 6 * 3600_000;
  const now = opts.now ?? Date.now;
  let last = -Infinity;
  return async () => {
    const t = now();
    if (t - last < every) return;
    last = t;
    await runRetention(db, root, { kind: "worker" }).catch(() => undefined);
  };
}
