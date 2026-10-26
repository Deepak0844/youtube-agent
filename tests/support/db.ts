import type pg from "pg";
import { Redis } from "ioredis";
import { createPool } from "@/server/db/pool";
import { migrate } from "@/server/db/migrate";
import { bootstrapRoles } from "@/server/db/bootstrap";
import { startInfra, type Infra } from "./infra";

export interface TestDb {
  pool: pg.Pool; // the runtime role (ytstudio_app): what the app and the code under test really use
  ownerPool: pg.Pool; // ytstudio_owner: seeding the app role may not do (audit_log rewrite), reset(), migrations
  superPool: pg.Pool; // container superuser: bootstrap only
  ownerUrl: string;
  redisUrl: string;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export const OWNER_PW = "test-owner-pw";
export const APP_PW = "test-app-pw";

function withRole(superUrl: string, user: string, password: string): string {
  const u = new URL(superUrl);
  u.username = user;
  u.password = password;
  return u.toString();
}

// Creates both roles on a fresh database and migrates as the owner. Returns the owner and app URLs.
export async function provisionRoles(superUrl: string): Promise<{ ownerUrl: string; appUrl: string }> {
  const superPool = createPool(superUrl);
  const ownerUrl = withRole(superUrl, "ytstudio_owner", OWNER_PW);
  try {
    await bootstrapRoles(superPool, { ownerPassword: OWNER_PW, appPassword: APP_PW });
  } finally {
    await superPool.end();
  }
  const ownerPool = createPool(ownerUrl);
  try {
    await migrate(ownerPool);
    // Test-only table used by the fake provider; created here because the app role may not run DDL.
    await ownerPool.query("create table if not exists fake_provider_calls (call_key text not null, at timestamptz not null default now())");
  } finally {
    await ownerPool.end();
  }
  return { ownerUrl, appUrl: withRole(superUrl, "ytstudio_app", APP_PW) };
}

// Starts real Postgres + Redis, creates the roles, migrates as owner. reset() truncates every app table (owner) and flushes Redis.
export async function withTestDb(): Promise<TestDb> {
  const infra = await startInfra();
  const superPool = createPool(infra.databaseUrl);
  const pools: pg.Pool[] = [superPool];
  try {
    const { ownerUrl, appUrl } = await provisionRoles(infra.databaseUrl);
    const ownerPool = createPool(ownerUrl);
    pools.push(ownerPool);
    const pool = createPool(appUrl);
    pools.push(pool);
    return build(infra, superPool, ownerPool, pool, ownerUrl);
  } catch (err) {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    await infra.stop().catch(() => {});
    throw err;
  }
}

function build(infra: Infra, superPool: pg.Pool, ownerPool: pg.Pool, pool: pg.Pool, ownerUrl: string): TestDb {
  return {
    pool,
    ownerPool,
    superPool,
    ownerUrl,
    redisUrl: infra.redisUrl,
    async reset() {
      const { rows } = await ownerPool.query<{ tablename: string }>(
        "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
      );
      if (rows.length > 0) {
        const names = rows.map((r) => `"${r.tablename}"`).join(", ");
        await ownerPool.query(`truncate ${names} restart identity cascade`);
      }
      const redis = new Redis(infra.redisUrl, { maxRetriesPerRequest: 1 });
      try {
        await redis.flushall();
      } finally {
        redis.disconnect();
      }
    },
    async stop() {
      await Promise.all([pool.end(), ownerPool.end(), superPool.end()]);
      await infra.stop();
    },
  };
}
