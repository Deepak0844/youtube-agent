import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPool } from "@/server/db/pool";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});

describe("createPool", () => {
  it("pool_idle_client_error_does_not_crash_the_process", async () => {
    const pool = createPool(db.pool.options.connectionString!);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const c = await pool.connect();
      c.release();
      // an idle client's connection breaks: pg emits "error" on the pool
      const idle = (pool as unknown as { _clients: { emit(e: string, err: Error): void }[] })._clients[0]!;
      idle.emit("error", new Error("terminating connection"));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject({ event: "pg.pool_idle_client_error" });
    } finally {
      spy.mockRestore();
      await pool.end();
    }
  });

  it("pool_connect_times_out_when_exhausted", async () => {
    const tiny = createPool(db.pool.options.connectionString!, { connectionTimeoutMillis: 300 });
    // the pool has max 10: exhaust it
    const clients = await Promise.all(Array.from({ length: 10 }, () => tiny.connect()));
    const t0 = Date.now();
    await expect(tiny.connect()).rejects.toThrow(/timeout/i);
    expect(Date.now() - t0).toBeLessThan(3000);
    clients.forEach((c) => c.release());
    await tiny.end();
  });
});
