import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@/server/core/ids";
import { loadActive, loadAttention, loadBreakers, loadKpis, loadRecent, loadUpNext } from "@/server/db/home-data";
import { withTestDb, type TestDb } from "../support/db";

// The Home screen's read functions on the real app role: each panel empty, populated and limited.
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const q = (sql: string, args: unknown[] = []) => db.ownerPool.query(sql, args);
async function video(topic: string, status = "active", createdAgoMin = 0): Promise<string> {
  const r = await q("insert into videos (format, kind, language, topic, status, created_at) values ('short','ai','en',$1,$2, now() - ($3 || ' minutes')::interval) returning id", [topic, status, String(createdAgoMin)]);
  return r.rows[0].id;
}
async function run(videoId: string, name: string, status: string, opts: { hash?: string; result?: object; agoMin?: number } = {}): Promise<string> {
  const id = uuidv7();
  await q("insert into stage_runs (id, video_id, name, status, input_hash, result, created_at, updated_at) values ($1,$2,$3,$4,$5,$6::jsonb, now() - ($7 || ' minutes')::interval, now() - ($7 || ' minutes')::interval)", [
    id, videoId, name, status, opts.hash ?? "h", opts.result ? JSON.stringify(opts.result) : null, String(opts.agoMin ?? 0),
  ]);
  return id;
}

describe("home data", () => {
  it("runs_on_the_app_role", async () => {
    expect((await db.pool.query("select current_user u")).rows[0].u).toBe("ytstudio_app");
  });

  it("every_panel_is_empty_on_a_fresh_studio", async () => {
    expect(await loadAttention(db.pool)).toEqual({ rows: [], total: 0 });
    expect(await loadActive(db.pool)).toEqual([]);
    expect(await loadUpNext(db.pool)).toEqual([]);
    expect(await loadRecent(db.pool)).toEqual([]);
    expect(await loadBreakers(db.pool)).toEqual([]);
    const k = await loadKpis(db.pool);
    expect(k).toMatchObject({ inProduction: 0, madeThisWeek: 0, publishedThisMonth: 0 });
    expect(k.today.spentMicroUsd).toBe(0);
  });

  it("attention_lists_failed_parked_budget_and_upload_failed_but_not_replaced_failures", async () => {
    const a = await video("failed one");
    await run(a, "render", "failed", { agoMin: 30 });
    const healed = await video("healed");
    await run(healed, "render", "failed", { agoMin: 30 });
    await run(healed, "render", "succeeded", { hash: "h2", agoMin: 5 });
    const b = await video("budget");
    await run(b, "generate", "needs_decision", { result: { needsDecision: "budget_refused: day" } });
    const c = await video("unclear");
    const sr = await run(c, "generate", "needs_decision", { result: { needsDecision: "paid_call_may_have_run" } });
    await q("insert into spend_intents (id, stage_run_id, step_index, tool_call_index, call_key, status) values ($1,$2,0,0,'k1','unknown')", [uuidv7(), sr]);
    const d = await video("upload", "waiting");
    await q("insert into uploads (id, video_id, status) values ($1,$2,'upload_failed')", [uuidv7(), d]);
    const done = await video("cancelled one", "cancelled");
    await run(done, "render", "failed");

    const r = await loadAttention(db.pool);
    expect(r.total).toBe(4);
    expect(r.rows.map((x) => [x.kind, x.topic])).toEqual([
      ["paid_unclear", "unclear"],
      ["upload_failed", "upload"],
      ["budget_held", "budget"],
      ["failed_stage", "failed one"],
    ]);
  });

  it("attention_is_bounded_but_counts_everything", async () => {
    for (let i = 0; i < 5; i++) await run(await video(`v${i}`), "render", "failed", { agoMin: i });
    const r = await loadAttention(db.pool, 3);
    expect(r.rows).toHaveLength(3);
    expect(r.total).toBe(5);
  });

  it("active_shows_running_runs_oldest_first_and_respects_the_limit", async () => {
    await run(await video("newer"), "build", "running", { agoMin: 1 });
    await run(await video("older"), "render", "running", { agoMin: 9 });
    await run(await video("not running"), "draft", "queued");
    expect((await loadActive(db.pool)).map((x) => [x.topic, x.stage])).toEqual([["older", "render"], ["newer", "build"]]);
    expect(await loadActive(db.pool, 1)).toHaveLength(1);
  });

  it("up_next_is_queued_videos_without_a_running_step_oldest_first_one_row_each", async () => {
    const a = await video("late");
    await run(a, "draft", "queued", { agoMin: 1 });
    const b = await video("early");
    await run(b, "draft", "queued", { agoMin: 20 });
    await run(b, "build", "queued", { hash: "h2", agoMin: 10 });
    const busy = await video("busy");
    await run(busy, "build", "running");
    await run(busy, "render", "queued", { hash: "h3" });
    const r = await loadUpNext(db.pool);
    expect(r.map((x) => [x.topic, x.stage])).toEqual([["early", "draft"], ["late", "draft"]]);
    expect(await loadUpNext(db.pool, 1)).toHaveLength(1);
  });

  it("recent_merges_events_and_audit_newest_first_skips_noise_and_is_bounded", async () => {
    const v = await video("Why sky");
    const sr = await run(v, "tts", "failed");
    await q("insert into events (at, video_id, stage_run_id, type) values (now() - interval '3 minutes', $1, $2, 'stage.failed')", [v, sr]);
    await q("insert into events (at, video_id, type) values (now() - interval '9 minutes', $1, 'log')", [v]);
    await q("insert into audit_log (at, event, detail) values (now() - interval '1 minute', 'key.set', '{}'), (now(), 'login.success', '{}')");
    const r = await loadRecent(db.pool);
    expect(r.map((x) => x.text)).toEqual(["An API key was saved to the vault", '"Why sky": recording the voice failed']);
    for (let i = 0; i < 20; i++) await q("insert into audit_log (event, detail) values ('key.set', '{}')");
    expect(await loadRecent(db.pool, 15)).toHaveLength(15);
  });

  it("kpis_count_real_rows_and_read_caps_from_budgets", async () => {
    await video("a", "active");
    await video("b", "waiting");
    await video("old", "done", 60 * 24 * 10);
    const pub = await video("pub", "done");
    await q("insert into uploads (id, video_id, status, finished_at) values ($1,$2,'uploaded', now())", [uuidv7(), pub]);
    const k = await loadKpis(db.pool);
    expect(k.inProduction).toBe(2);
    expect(k.madeThisWeek).toBe(3);
    expect(k.publishedThisMonth).toBe(1);
    expect(k.today.capMicroUsd).toBe(15_000_000);
    expect(k.month.capMicroUsd).toBe(100_000_000);
    await q("update budgets set cap_micro_usd = null where scope = 'day'");
    expect((await loadKpis(db.pool)).today.capMicroUsd).toBeNull();
  });
});
