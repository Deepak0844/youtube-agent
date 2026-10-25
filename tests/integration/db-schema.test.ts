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

  it("uploads_allow_one_active_row_per_video", async () => {
    const video = uuidv7();
    const ins = (status: string, v = video) =>
      db.pool.query("insert into uploads (id, video_id, status) values ($1,$2,$3)", [uuidv7(), v, status]);
    await ins("publish_approved");
    await ins("publish_approved");
    await ins("upload_failed");
    await ins("uploading");
    await expect(ins("uploading")).rejects.toMatchObject({ code: "23505" });
    await expect(ins("uploaded")).rejects.toMatchObject({ code: "23505" });
    await ins("uploading", uuidv7());
    const v2 = uuidv7();
    await ins("uploaded", v2);
    await expect(ins("uploaded", v2)).rejects.toMatchObject({ code: "23505" });
  });

  it("uploads_have_timestamps_failure_reason_and_query_indexes", async () => {
    const cols = await db.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='uploads'",
    );
    for (const c of ["created_at", "updated_at", "failure_reason"]) expect(cols.rows.map((r) => r.column_name)).toContain(c);
    const idx = await db.pool.query<{ indexname: string }>("select indexname from pg_indexes where tablename='uploads'");
    for (const i of ["uploads_channel_started_idx", "uploads_status_progress_idx", "uploads_one_active_per_video"]) {
      expect(idx.rows.map((r) => r.indexname)).toContain(i);
    }
  });

  it("spend_intents_record_scopes_and_budgets_reject_negative_amounts", async () => {
    const cols = await db.pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name='spend_intents'",
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(expect.arrayContaining(["scopes", "attempts"]));
    const stage = await insertStage();
    await insertIntent(stage, "k-scopes");
    const { rows } = await db.pool.query("select scopes from spend_intents where call_key='k-scopes'");
    expect(rows[0].scopes).toEqual([]);
    const att = await db.pool.query("select attempts from spend_intents where call_key='k-scopes'");
    expect(att.rows[0].attempts).toBe(1);
    await expect(
      db.pool.query("insert into budgets (scope, cap_micro_usd, reserved_micro_usd) values ('neg', 10, -1)"),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(db.pool.query("insert into budgets (scope, cap_micro_usd) values ('neg2', -1)")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("migrate_destroys_the_client_when_unlock_fails_and_recovers", async () => {
    const released: unknown[] = [];
    const connect = async () => {
      const client = await db.pool.connect();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = (text: unknown, ...rest: unknown[]) => {
        if (typeof text === "string" && text.includes("pg_advisory_unlock")) return Promise.reject(new Error("boom"));
        return query(text, ...rest);
      };
      const release = client.release.bind(client);
      client.release = ((arg?: boolean | Error) => {
        released.push(arg);
        release(arg as boolean);
      }) as typeof client.release;
      return client;
    };
    await migrate(db.pool, connect);
    expect(released).toEqual([true]);
    await migrate(db.pool);
    const { rows } = await db.pool.query("select name from schema_migrations");
    expect(rows).toHaveLength(1);
  });
});
