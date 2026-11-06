import { describe, expect, it } from "vitest";
import { cpuLoadFraction, formatMetrics, sumQueues, type HealthSnapshot } from "@/server/core/health";

const snap: HealthSnapshot = {
  db: { ok: true },
  redis: { ok: false },
  disk: { freeBytes: 100, totalBytes: 400 },
  queue: { waiting: 2, active: 1, failed: 3 },
  cpuLoad: 0.25,
  memory: { usedBytes: 10, totalBytes: 40 },
  storageBytes: 7,
};

describe("formatMetrics", () => {
  it("emits Prometheus gauges with HELP and TYPE", () => {
    const t = formatMetrics(snap);
    expect(t).toContain("# TYPE db_up gauge\ndb_up 1\n");
    expect(t).toContain("redis_up 0\n");
    for (const l of ["disk_free_bytes 100", "disk_total_bytes 400", "queue_waiting 2", "queue_active 1", "queue_failed 3", "process_cpu_load 0.25", "memory_used_bytes 10", "memory_total_bytes 40", "storage_used_bytes 7"]) expect(t).toContain(l + "\n");
    expect(t.endsWith("\n")).toBe(true);
  });
  it("skips unknown values instead of printing NaN", () => {
    const t = formatMetrics({ ...snap, queue: null, storageBytes: null, cpuLoad: Number.NaN });
    expect(t).not.toMatch(/NaN|null|undefined/);
    expect(t).not.toContain("queue_waiting");
  });
});

describe("cpuLoadFraction", () => {
  it("divides the 1-minute load by cores", () => expect(cpuLoadFraction(2, 8)).toBe(0.25));
  it("guards zero cores", () => expect(cpuLoadFraction(2, 0)).toBe(0));
});

describe("sumQueues", () => {
  it("adds counts across queues, missing keys are 0", () =>
    expect(sumQueues([{ waiting: 1, failed: 2 }, { waiting: 1, active: 4 }])).toEqual({ waiting: 2, active: 4, failed: 2 }));
});
