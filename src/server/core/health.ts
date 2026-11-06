// Pure helpers for the live-health rows and GET /metrics. No IO.

export interface QueueCounts { waiting: number; active: number; failed: number }

export interface HealthSnapshot {
  db: { ok: boolean };
  redis: { ok: boolean };
  disk: { freeBytes: number; totalBytes: number };
  /** null when Redis is down. */
  queue: QueueCounts | null;
  /** 1-minute load average divided by core count (1 = all cores busy). */
  cpuLoad: number;
  memory: { usedBytes: number; totalBytes: number };
  /** null when unknown. */
  storageBytes: number | null;
}

export const cpuLoadFraction = (load1: number, cores: number): number => (cores > 0 ? load1 / cores : 0);

export function sumQueues(counts: Array<Partial<QueueCounts>>): QueueCounts {
  const t: QueueCounts = { waiting: 0, active: 0, failed: 0 };
  for (const c of counts) {
    t.waiting += c.waiting ?? 0;
    t.active += c.active ?? 0;
    t.failed += c.failed ?? 0;
  }
  return t;
}

/** Prometheus text exposition. Numbers only: no labels, no paths, no secrets. Non-finite values are left out. */
export function formatMetrics(s: HealthSnapshot): string {
  const rows: Array<[string, string, number | null]> = [
    ["db_up", "1 when Postgres answers", s.db.ok ? 1 : 0],
    ["redis_up", "1 when Redis answers", s.redis.ok ? 1 : 0],
    ["disk_free_bytes", "Free bytes on the storage disk", s.disk.freeBytes],
    ["disk_total_bytes", "Total bytes on the storage disk", s.disk.totalBytes],
    ["queue_waiting", "Jobs waiting in all queues", s.queue?.waiting ?? null],
    ["queue_active", "Jobs running in all queues", s.queue?.active ?? null],
    ["queue_failed", "Failed jobs kept in all queues", s.queue?.failed ?? null],
    ["process_cpu_load", "1-minute load average per core", s.cpuLoad],
    ["memory_used_bytes", "Memory in use on this machine", s.memory.usedBytes],
    ["memory_total_bytes", "Total memory on this machine", s.memory.totalBytes],
    ["storage_used_bytes", "Bytes used under the storage folder (cached estimate)", s.storageBytes],
  ];
  return rows
    .filter((r): r is [string, string, number] => r[2] !== null && Number.isFinite(r[2]))
    .map(([n, h, v]) => `# HELP ${n} ${h}\n# TYPE ${n} gauge\n${n} ${v}\n`)
    .join("");
}
