import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import { Redis } from "ioredis";
import type pg from "pg";
import appPkg from "../../../package.json";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus, type VaultStatus } from "@/server/db/vault";

// Read-only facts for /settings/system. Nothing returned here is a secret: no connection strings, no key material, no
// error text from the drivers (they can echo hosts and credentials). Failures become a plain "down".

export interface SystemStatus {
  versions: { app: string; node: string; next: string; postgres: string | null };
  db: { ok: boolean; ms: number | null };
  redis: { ok: boolean; ms: number | null };
  vault: VaultStatus;
  disk: { root: string; freeBytes: number; totalBytes: number };
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

export function storageRoot(): string {
  return path.resolve(process.env.STORAGE_ROOT ?? ".data");
}

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

export async function getSystemStatus(db: pg.Pool, opts: { redisUrl?: string } = {}): Promise<SystemStatus> {
  const pgRes = await timed(db.query<{ v: string }>("select current_setting('server_version') as v"), 2000);
  let vault: VaultStatus;
  try {
    vault = await vaultStatus(db, loadKeyring);
  } catch {
    vault = { status: "unreadable", unreadable: [] };
  }
  const [redis, disk] = await Promise.all([checkRedis(opts.redisUrl ?? process.env.REDIS_URL), diskFor(storageRoot())]);
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
  };
}
