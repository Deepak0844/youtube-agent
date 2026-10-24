import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "@/server/db/migrate";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
});

async function insertStage(status = "queued"): Promise<string> {
  const id = uuidv7();
  await db.pool.query("insert into stage_runs (id, video_id, name, status, input_hash) values ($1,$2,'script',$3,'h')", [
    id,
    uuidv7(),
    status,
  ]);
  return id;
}

async function insertIntent(stageId: string, callKey: string, status = "pending") {
  return db.pool.query(
    "insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status, reserved_micro_usd) values ($1,$2,0,0,$3,$4,100)",
    [uuidv7(), stageId, callKey, status],
  );
}

describe("schema", () => {
  it("migrate_creates_all_tables", async () => {
    const { rows } = await db.pool.query<{ tablename: string }>("select tablename from pg_tables where schemaname='public'");
    const names = rows.map((r) => r.tablename);
    for (const t of ["stage_runs", "spend_intents", "budgets", "uploads", "upload_log", "schema_migrations"]) {
      expect(names).toContain(t);
    }
  });

  it("migrate_is_idempotent", async () => {
    await migrate(db.pool);
    await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
    const { rows } = await db.pool.query("select name from schema_migrations");
    expect(rows).toHaveLength(1);
  });

  it("status_check_constraints_reject_unknown_values", async () => {
    await expect(insertStage("bogus")).rejects.toMatchObject({ code: "23514" });
    const stage = await insertStage();
    await expect(insertIntent(stage, "k-bad", "bogus")).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.pool.query("insert into uploads (id, video_id, status) values ($1,$2,'bogus')", [uuidv7(), uuidv7()]),
    ).rejects.toMatchObject({ code: "23514" });
    for (const s of ["queued", "running", "succeeded", "failed", "needs_decision", "cancelled"]) await insertStage(s);
  });

  it("call_key_is_unique", async () => {
    const stage = await insertStage();
    await insertIntent(stage, "same-key");
    await expect(insertIntent(stage, "same-key")).rejects.toMatchObject({ code: "23505" });
  });

  it("fence_defaults_to_zero", async () => {
    const id = await insertStage();
    const { rows } = await db.pool.query("select fence, attempt_seq, cancel_requested from stage_runs where id=$1", [id]);
    expect(rows[0]).toEqual({ fence: "0", attempt_seq: 0, cancel_requested: false });
  });
});
