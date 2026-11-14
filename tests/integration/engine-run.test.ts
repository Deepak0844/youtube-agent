import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import { killStaleEngineRuns } from "@/server/db/engine-runs";
import { createVideoRow } from "@/server/db/videos";
import { runEngine, type EngineDeps } from "@/server/engine/run";
import { withTestDb, type TestDb } from "../support/db";

// The engine run launcher with a scripted fake `claude` (tests/fixtures/fake-claude.mjs): flags, folder, environment, usage,
// limits, time limit, cancel, folder-rule breaks and a worker restart.

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");
const STAGE = "0190f3a2-7c1e-7a55-9d3b-2f6c8a1b4e91";
let db: TestDb;
let root: string;
beforeAll(async () => {
  db = await withTestDb();
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "eng-runs-")));
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const on = { ...buildEngineConfig(new Map()).engine, enabled: true };
const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
  db: db.pool, root, config: on, command: { cmd: process.execPath, prefix: [FAKE] },
  env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: "u", LANG: "C", TERM: "dumb", DATABASE_URL: "postgres://secret", ANTHROPIC_API_KEY: "sk-secret", VAULT_KEY: "v" },
  tools: () => [], now: () => new Date("2026-11-13T12:00:00Z"), killGraceMs: 200, ...over,
});
const video = async () => (await createVideoRow(db.pool, { format: "short", kind: "tsx", language: "en", topic: "engine" })).id;
const req = (videoId: string, job: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ videoId, stageRunId: STAGE, kind: "build" as const, prompt: JSON.stringify(job), long: false, signal: new AbortController().signal, ...over });
const row = async (videoId: string) => (await db.pool.query("select status, input_tokens, output_tokens, cost_usd_equiv::text as cost, turns, resume_at, error from engine_runs where video_id = $1 order by started_at desc limit 1", [videoId])).rows[0];

describe("runEngine", () => {
  it("refuses_when_engine_disabled (no process starts, no row)", async () => {
    const v = await video();
    expect(await runEngine(deps({ config: { ...on, enabled: false } }), req(v, { mode: "ok" }))).toEqual({ ok: false, limit: false, message: "The new engine is switched off in Settings." });
    expect(await row(v)).toBeUndefined();
  });

  it("runs inside work/ with the build flags and records usage", async () => {
    const v = await video();
    const r = await runEngine(deps(), req(v, { mode: "args" }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    const seen = JSON.parse(r.text) as { cwd: string; args: string[] };
    expect(seen.cwd).toBe(path.join(root, "videos", v, "engine", "work"));
    expect(seen.args).toContain("--strict-mcp-config");
    expect(seen.args[seen.args.indexOf("--allowedTools") + 1]).toBe("Edit(./**),Skill,mcp__engine__*");
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 300, costUsdEquiv: 0.25 });
    expect(await row(v)).toMatchObject({ status: "succeeded", input_tokens: "1200", output_tokens: "300", cost: "0.250000", turns: 3 });
  });

  it("env_has_no_secrets", async () => {
    const v = await video();
    const r = await runEngine(deps(), req(v, { mode: "env" }));
    if (!r.ok) throw new Error("run failed");
    expect(JSON.parse(r.text)).toEqual(expect.arrayContaining(["HOME", "PATH", "USER"]));
    expect(r.text).not.toMatch(/DATABASE_URL|ANTHROPIC|VAULT/);
  });

  it("forbidden_write_outside_fails_the_run", async () => {
    const v = await video();
    const r = await runEngine(deps(), req(v, { mode: "outside" }));
    expect(r).toEqual({ ok: false, limit: false, message: expect.stringMatching(/^The run broke its folder rules \(outside the work folder: escaped\.txt\)\.$/) });
    expect(await row(v)).toMatchObject({ status: "failed" });
  });

  it("a usage limit pauses with the reset time", async () => {
    const v = await video();
    expect(await runEngine(deps(), req(v, { mode: "limit" }))).toEqual({ ok: false, limit: true, resumeAt: new Date("2026-11-13T14:30:00Z") });
    expect((await row(v)).status).toBe("limit");
  });

  it("a limit with no time retries after engine.limit_retry_s", async () => {
    const v = await video();
    const r = await runEngine(deps({ config: { ...on, limitRetryS: 1800 } }), req(v, { mode: "limit" }, { prompt: JSON.stringify({ mode: "limit" }) }));
    expect(r).toMatchObject({ ok: false, limit: true });
  });

  it("running out of turns and a crash are plain failures", async () => {
    const v = await video();
    expect(await runEngine(deps(), req(v, { mode: "turns" }))).toEqual({ ok: false, limit: false, message: "Claude used all its turns without finishing." });
    expect(await runEngine(deps(), req(v, { mode: "crash" }))).toEqual({ ok: false, limit: false, message: "Claude Code stopped with an error." });
  });

  it("timeout_kills_the_group", async () => {
    const v = await video();
    const r = await runEngine(deps({ config: { ...on, buildTimeoutS: 1 } }), req(v, { mode: "hang" }));
    expect(r).toEqual({ ok: false, limit: false, message: "The Claude run took longer than its 1 min limit and was stopped." });
    const kid = Number(readFileSync(path.join(root, "videos", v, "engine", "work", "kid.pid"), "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(() => process.kill(kid, 0)).toThrow(); // the grandchild is gone too
    expect((await row(v)).status).toBe("killed");
  }, 20_000);

  it("cancel_kills_the_group", async () => {
    const v = await video();
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("cancelled")), 500);
    expect(await runEngine(deps(), req(v, { mode: "hang" }, { signal: ac.signal }))).toEqual({ ok: false, limit: false, message: "The run was cancelled." });
    expect((await row(v)).status).toBe("killed");
  }, 20_000);

  it("a second run of the same video while one is running is refused", async () => {
    const v = await video();
    const ac = new AbortController();
    const first = runEngine(deps(), req(v, { mode: "hang" }, { signal: ac.signal }));
    await new Promise((res) => setTimeout(res, 300));
    expect(await runEngine(deps(), req(v, { mode: "ok" }))).toEqual({ ok: false, limit: false, message: "Another engine run of this video is still going." });
    ac.abort(new Error("stop"));
    await first;
  }, 20_000);

  it("a run left marked running by a crashed try is closed, and the step runs again", async () => {
    // the database dropped after Claude finished, so the run was never ended; the retry of the step must not be blocked
    const v = await video();
    await db.pool.query("insert into engine_runs (video_id, stage_run_id, kind) values ($1, $2, 'build')", [v, STAGE]);
    const r = await runEngine(deps(), req(v, { mode: "ok" }));
    expect(r.ok).toBe(true);
    const rows = (await db.pool.query("select status, error from engine_runs where video_id = $1 order by started_at", [v])).rows;
    expect(rows).toEqual([
      { status: "killed", error: "An earlier try of this step stopped without finishing; the step ran again." },
      { status: "succeeded", error: null },
    ]);
  }, 20_000);

  it("registers Claude with the identity the orphan sweep checks, and unregisters it at the end", async () => {
    const v = await video();
    const reg: Array<{ pid: number; startedAtEpoch: number; commandLabel: string; argsSha256: string }> = [];
    const unreg: Array<[number, number]> = [];
    const registry = { register: async (r: (typeof reg)[number]) => void reg.push(r), unregister: async (pid: number, at: number) => void unreg.push([pid, at]) };
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("stop")), 1500);
    await runEngine(deps({ registry }), req(v, { mode: "hang" }, { signal: ac.signal }));
    expect(reg).toHaveLength(1);
    expect(reg[0]!.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reg[0]!.commandLabel).toBe("node"); // the fake runs under node; the real one is "claude"
    expect(unreg).toEqual([[reg[0]!.pid, reg[0]!.startedAtEpoch]]);
  }, 20_000);

  it("worker_restart_leaves_run_killed", async () => {
    const v = await video();
    await db.pool.query("insert into engine_runs (video_id, stage_run_id, kind) values ($1, $2, 'build')", [v, STAGE]);
    expect(await killStaleEngineRuns(db.pool)).toBe(1);
    expect(await row(v)).toMatchObject({ status: "killed", error: "The worker restarted during this run." });
  });
});
