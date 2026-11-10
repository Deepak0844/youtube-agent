import { readdir, readFile, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type pg from "pg";
import appPkg from "../../../package.json";
import { cpuLoadFraction, sumQueues, type QueueCounts } from "@/server/core/health";
import type { ToolCheck } from "@/server/core/tool-check";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus, type VaultStatus } from "@/server/db/vault";
import { cachedToolChecks } from "@/server/render/tool-check";
import { storageRoot } from "@/server/storage/paths";

// Read-only facts for /settings/system. Nothing returned here is a secret: no connection strings, no key material, no
// error text from the drivers (they can echo hosts and credentials). Failures become a plain "down".

export interface SystemStatus {
  versions: { app: string; node: string; next: string; postgres: string | null };
  db: { ok: boolean; ms: number | null };
  redis: { ok: boolean; ms: number | null };
  vault: VaultStatus;
  disk: { root: string; freeBytes: number; totalBytes: number };
  cpuLoad: number;
  memory: { usedBytes: number; totalBytes: number };
  /** null when Redis is down or not configured. */
  queue: QueueCounts | null;
  /** null when unknown. Cached estimate, see storageUsedBytes. */
  storageBytes: number | null;
  /** ffmpeg, ffprobe, Docker and the render image (checked at most once a minute). */
  tools: ToolCheck[];
}

async function timed<T>(work: Promise<T>, ms: number): Promise<{ ok: true; value: T; ms: number } | { ok: false }> {
  const t0 = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]);
    return { ok: true, value, ms: Math.round(performance.now() - t0) };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

async function checkRedis(url: string | undefined): Promise<{ ok: boolean; ms: number | null }> {
  if (!url) return { ok: false, ms: null };
  let client: Redis | undefined;
  try {
    const c = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, connectTimeout: 1500, enableOfflineQueue: false });
    client = c;
    c.on("error", () => undefined);
    const r = await timed(c.connect().then(() => c.ping()), 2000);
    return r.ok ? { ok: true, ms: r.ms } : { ok: false, ms: null };
  } catch {
    return { ok: false, ms: null };
  } finally {
    client?.disconnect();
  }
}

async function nextVersion(): Promise<string> {
  try {
    const j = JSON.parse(await readFile(path.join(process.cwd(), "node_modules", "next", "package.json"), "utf8")) as { version?: unknown };
    return typeof j.version === "string" ? j.version : "unknown";
  } catch {
    return "unknown";
  }
}

// Moved to storage/paths.ts (Task 10); re-exported so existing imports keep working.
export { storageRoot };

/** What the page shows for a folder: relative to the app when inside it, otherwise only the last two segments. Never a home directory. */
export function displayPath(abs: string, cwd: string = process.cwd()): string {
  const rel = path.relative(cwd, abs);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  const tail = abs.split(path.sep).filter(Boolean).slice(-2).join("/");
  return tail ? `…/${tail}` : "…";
}

async function diskFor(root: string): Promise<SystemStatus["disk"]> {
  for (const dir of [root, path.dirname(root), process.cwd()]) {
    try {
      const s = await statfs(dir);
      return { root: displayPath(root), freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      /* try the next parent */
    }
  }
  return { root: displayPath(root), freeBytes: 0, totalBytes: 0 };
}

const QUEUES = ["stages", "uploads", "ingest"] as const;

async function queueCounts(url: string | undefined): Promise<QueueCounts | null> {
  if (!url) return null;
  const qs = QUEUES.map((n) => {
    const q = new Queue(n, { connection: { url, maxRetriesPerRequest: null, enableOfflineQueue: false, connectTimeout: 1000, retryStrategy: () => null } });
    q.on("error", () => undefined);
    return q;
  });
  try {
    const r = await timed(Promise.all(qs.map((q) => q.getJobCounts("waiting", "active", "failed"))), 2000);
    return r.ok ? sumQueues(r.value) : null;
  } catch {
    return null;
  } finally {
    await Promise.allSettled(qs.map((q) => q.disconnect()));
  }
}

// Folder size is a walk, so it is never done per request: one walk per minute at most, capped at MAX_ENTRIES files.
const STORAGE_TTL_MS = 60_000;
const MAX_ENTRIES = 20_000;
let storageCache: { root: string; at: number; bytes: number } | undefined;

export async function storageUsedBytes(root: string): Promise<number | null> {
  if (storageCache && storageCache.root === root && Date.now() - storageCache.at < STORAGE_TTL_MS) return storageCache.bytes;
  let bytes = 0;
  let seen = 0;
  const stack = [root];
  try {
    while (stack.length > 0 && seen < MAX_ENTRIES) {
      const dir = stack.pop()!;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (++seen > MAX_ENTRIES) break;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) bytes += (await stat(full)).size;
      }
    }
  } catch {
    if (seen === 0) return null;
  }
  storageCache = { root, at: Date.now(), bytes };
  return bytes;
}

export async function getSystemStatus(db: pg.Pool, opts: { redisUrl?: string } = {}): Promise<SystemStatus> {
  const pgRes = await timed(db.query<{ v: string }>("select current_setting('server_version') as v"), 2000);
  let vault: VaultStatus;
  try {
    vault = await vaultStatus(db, loadKeyring);
  } catch {
    vault = { status: "unreadable", unreadable: [] };
  }
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  const root = storageRoot();
  const [redis, disk, queue, storageBytes, tools] = await Promise.all([checkRedis(redisUrl), diskFor(root), queueCounts(redisUrl), storageUsedBytes(root), cachedToolChecks()]);
  const totalMem = os.totalmem();
  return {
    versions: {
      app: appPkg.version,
      node: process.versions.node,
      next: await nextVersion(),
      postgres: pgRes.ok ? (pgRes.value.rows[0]?.v.split(" ")[0] ?? null) : null,
    },
    db: pgRes.ok ? { ok: true, ms: pgRes.ms } : { ok: false, ms: null },
    redis,
    vault,
    disk,
    cpuLoad: cpuLoadFraction(os.loadavg()[0] ?? 0, os.availableParallelism()),
    memory: { usedBytes: totalMem - os.freemem(), totalBytes: totalMem },
    queue: redis.ok ? queue : null,
    storageBytes,
    tools,
  };
}
