import type pg from "pg";
import { Redis } from "ioredis";
import { createPool } from "@/server/db/pool";
import { migrate } from "@/server/db/migrate";
import { startInfra } from "./infra";

export interface TestDb {
  pool: pg.Pool;
  redisUrl: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

// Starts real Postgres + Redis, applies migrations. reset() truncates every app table and flushes Redis.
export async function withTestDb(): Promise<TestDb> {
  const infra = await startInfra();
  const pool = createPool(infra.databaseUrl);
  try {
    await migrate(pool);
  } catch (err) {
    await pool.end().catch(() => {});
    await infra.stop().catch(() => {});
    throw err;
  }
  return {
    pool,
    redisUrl: infra.redisUrl,
    async reset() {
      const { rows } = await pool.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
      );
      if (rows.length > 0) {
        const names = rows.map((r) => `"${r.tablename}"`).join(", ");
        await pool.query(`truncate ${names} restart identity cascade`);
      }
      const redis = new Redis(infra.redisUrl, { maxRetriesPerRequest: 1 });
      try {
        await redis.flushall();
      } finally {
        redis.disconnect();
      }
    },
    async stop() {
      await pool.end();
      await infra.stop();
    },
  };
}
