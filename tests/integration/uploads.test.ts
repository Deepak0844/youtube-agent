import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { createJobQueue, type StageQueue, type UploadQueue } from "@/server/queue/job-queue";
import * as uploadsModule from "@/server/db/uploads";
import { finishUpload, manualRetry, markStalled, reportProgress, startUpload, STALLED_REASON, type StartCtx } from "@/server/db/uploads";
import { handleUploadJob, runUpload, type UploadJobDeps } from "@/server/db/upload-job";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";
import { waitFor } from "./helpers/stage-env";

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

const CAPS = { maxPerDay: 6, minSpacingMs: 0, dailyQuotaUnits: 1_000_000, costUnits: 1 };
const ctx = (over: Partial<StartCtx> = {}): StartCtx => ({ currentApprovalHash: "appr", currentFileSha: "sha", caps: CAPS, ...over });

const rctx = (over: Partial<StartCtx> = {}) => ({ ...ctx(over), humanConfirmedNotOnYouTube: true as const });

async function newUpload(o: { videoId?: string; channel?: string | null; status?: string; approval?: string; sha?: string; startedAgoMs?: number } = {}): Promise<string> {
  const id = uuidv7();
  await db.pool.query(
    `insert into uploads (id, video_id, status, approval_hash, file_sha, channel_id, bytes_total, started_at, last_progress_at)
     values ($1,$2,$3,$4,$5,$6,1000000, case when $7::bigint is null then null else clock_timestamp() - ($7::bigint * interval '1 millisecond') end,
                                          case when $7::bigint is null then null else clock_timestamp() - ($7::bigint * interval '1 millisecond') end)`,
    [id, o.videoId ?? uuidv7(), o.status ?? "publish_approved", o.approval ?? "appr", o.sha ?? "sha", o.channel === undefined ? "chan" : o.channel, o.startedAgoMs ?? null],
  );
  return id;
}
async function row(id: string) {
  const { rows } = await db.pool.query("select * from uploads where id = $1", [id]);
  return rows[0];
}
async function logs(id: string): Promise<string[]> {
  const { rows } = await db.pool.query("select event from upload_log where upload_id = $1 order by id", [id]);
  return rows.map((r) => r.event);
}

describe("startUpload", () => {
  it("second_delivery_finds_uploading_and_does_nothing", async () => {
    const id = await newUpload();
    expect(await startUpload(db.pool, id, ctx())).toEqual({ started: true, attempt: 1 });
    const before = await row(id);
    expect(await startUpload(db.pool, id, ctx())).toEqual({ started: false, reason: "not_publish_approved" });
    expect(await row(id)).toEqual(before);
    expect(await logs(id)).toEqual(["started"]);
  });

  it("twenty_concurrent_starts_exactly_one_wins", async () => {
    const id = await newUpload();
    const results = await Promise.all(Array.from({ length: 20 }, () => startUpload(db.pool, id, ctx())));
    expect(results.filter((r) => r.started)).toHaveLength(1);
    expect(await logs(id)).toEqual(["started"]);
  });

  it("concurrent_starts_blocked_behind_the_channel_lock_still_yield_exactly_one_winner", async () => {
    // Deterministic version of the race: a blocker holds the channel's advisory lock while 8 starts pile up,
    // so every start has already read the row (or is waiting on its row lock) before any can proceed.
    const id = await newUpload();
    const blocker = await db.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('chan', 0))");
      const starts = Array.from({ length: 8 }, () => startUpload(db.pool, id, ctx()));
      await waitFor(async () => {
        const { rows } = await db.pool.query("select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()");
        return rows[0].n >= 1;
      }, "starts blocked");
      await new Promise((r) => setTimeout(r, 300)); // let the rest reach their lock
      await blocker.query("commit");
      const results = await Promise.all(starts);
      expect(results.filter((r) => r.started)).toHaveLength(1);
      expect(await logs(id)).toEqual(["started"]);
    } finally {
      blocker.release();
    }
  });

  it("redelivery_after_uploaded_does_nothing", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "yt1" })).toBe(true);
    expect(await startUpload(db.pool, id, ctx())).toEqual({ started: false, reason: "not_publish_approved" });
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "yt1" });
  });

  it("approval_changed_blocks_start", async () => {
    const id = await newUpload();
    expect(await startUpload(db.pool, id, ctx({ currentApprovalHash: "other" }))).toEqual({ started: false, reason: "approval_changed" });
    expect((await row(id)).status).toBe("publish_approved");
  });

  it("file_changed_blocks_start", async () => {
    const id = await newUpload();
    expect(await startUpload(db.pool, id, ctx({ currentFileSha: "other" }))).toEqual({ started: false, reason: "file_changed" });
    expect((await row(id)).status).toBe("publish_approved");
  });

  it("daily_cap_spacing_and_quota_block_start", async () => {
    await newUpload({ status: "uploaded", startedAgoMs: 10 });
    const id = await newUpload();
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } }))).toEqual({ started: false, reason: "spacing" });
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, dailyQuotaUnits: 1, costUnits: 1 } }))).toEqual({ started: false, reason: "quota" });
    expect((await row(id)).status).toBe("publish_approved");
  });

  it("starts_serialise_per_channel_for_spacing", async () => {
    const spaced = ctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } });
    for (let round = 0; round < 20; round++) {
      await db.reset();
      const a = await newUpload();
      const b = await newUpload();
      const [ra, rb] = await Promise.all([startUpload(db.pool, a, spaced), startUpload(db.pool, b, spaced)]);
      expect([ra.started, rb.started].filter(Boolean)).toHaveLength(1);
      const loser = ra.started ? rb : ra;
      expect(loser).toEqual({ started: false, reason: "spacing" });
    }
  });

  it("unique_index_violation_maps_to_not_started", async () => {
    const video = uuidv7();
    const a = await newUpload({ videoId: video, channel: "c1" });
    const b = await newUpload({ videoId: video, channel: "c2" });
    expect(await startUpload(db.pool, a, ctx())).toEqual({ started: true, attempt: 1 });
    expect(await startUpload(db.pool, b, ctx())).toEqual({ started: false, reason: "another_upload_active_for_video" });
    expect((await row(b)).status).toBe("publish_approved");
    // joined to a caller's transaction the savepoint keeps the caller's transaction usable
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      expect(await startUpload(client, b, ctx())).toEqual({ started: false, reason: "another_upload_active_for_video" });
      await client.query("select 1");
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  it("validates inputs before touching the db", async () => {
    await expect(startUpload(db.pool, "nope", ctx())).rejects.toThrow(RangeError);
    await expect(startUpload(db.pool, uuidv7(), ctx({ caps: { ...CAPS, maxPerDay: -1 } }))).rejects.toThrow(RangeError);
    expect(await startUpload(db.pool, uuidv7(), ctx())).toEqual({ started: false, reason: "not_found" });
  });
});

describe("progress and finish", () => {
  it("progress_is_monotonic", async () => {
    const id = await newUpload();
    expect(await reportProgress(db.pool, id, 1, 10)).toBe(false); // not uploading yet
    await startUpload(db.pool, id, ctx());
    expect(await reportProgress(db.pool, id, 1, 500)).toBe(true);
    expect(await reportProgress(db.pool, id, 1, 400)).toBe(false);
    expect(await reportProgress(db.pool, id, 1, 500)).toBe(true);
    expect(await row(id)).toMatchObject({ bytes_sent: "500" });
    await expect(reportProgress(db.pool, id, 1, -1)).rejects.toThrow(RangeError);
    await expect(reportProgress(db.pool, id, 1, 1.5)).rejects.toThrow(RangeError);
  });

  it("finish_only_from_uploading", async () => {
    const id = await newUpload();
    expect(await finishUpload(db.pool, id, 1, { kind: "duplicate_skipped" })).toBe(false); // no id: does not block the later start
    expect(await finishUpload(db.pool, id, 1, { kind: "failed", reason: "x" })).toBe(false);
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, 1, { kind: "failed", reason: "boom\u0000\ud800" + "x".repeat(300) })).toBe(true);
    const r = await row(id);
    expect(r.status).toBe("upload_failed");
    expect([...r.failure_reason]).toHaveLength(200);
    expect(r.failure_reason).not.toContain("\u0000");
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "late" })).toBe(false);
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("duplicate_skipped_counts_as_failure", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, 1, { kind: "duplicate_skipped", youtubeId: "yt9" })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "upload_failed", failure_reason: "duplicate_skipped: check YouTube Studio", youtube_id: "yt9" });
  });

  it("bigint_columns_convert_safely", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await db.pool.query("update uploads set bytes_total = null where id = $1", [id]);
    await expect(reportProgress(db.pool, id, 1, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(RangeError);
    expect(await reportProgress(db.pool, id, 1, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect((await row(id)).bytes_sent).toBe(String(Number.MAX_SAFE_INTEGER));
    // an out-of-range count already stored cannot be silently truncated into the cap check
    await db.pool.query("update uploads set started_at = clock_timestamp() where id = $1", [id]);
    const other = await newUpload();
    expect(await startUpload(db.pool, other, ctx())).toEqual({ started: true, attempt: 1 }); // count (bigint string) converted
  });
});

describe("stall detection", () => {
  it("slow_but_progressing_upload_is_never_marked_failed", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 120));
      expect(await reportProgress(db.pool, id, 1, i * 10)).toBe(true);
      expect(await markStalled(db.pool, 300)).toEqual([]); // total elapsed > 300ms, but progress is fresh
    }
    expect((await row(id)).status).toBe("uploading");
  });

  it("markStalled_uses_db_clock_and_leaves_progressing_uploads_alone", async () => {
    const stale = await newUpload({ status: "uploading", startedAgoMs: 60_000, channel: "c1" });
    const fresh = await newUpload({ status: "uploading", startedAgoMs: 100, channel: "c2" });
    const uploaded = await newUpload({ status: "uploaded", startedAgoMs: 60_000, channel: "c3" });
    const approved = await newUpload({ channel: "c4" });
    expect(await markStalled(db.pool, 30_000)).toEqual([stale]);
    expect(await row(stale)).toMatchObject({ status: "upload_failed", failure_reason: "no progress: check YouTube Studio first" });
    expect((await row(fresh)).status).toBe("uploading");
    expect((await row(uploaded)).status).toBe("uploaded");
    expect((await row(approved)).status).toBe("publish_approved");
    expect(await logs(stale)).toEqual(["stalled"]);
    await expect(markStalled(db.pool, 0)).rejects.toThrow(RangeError);
  });

  it("no_progress_marks_upload_failed_and_never_retries_automatically", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await new Promise((r) => setTimeout(r, 150));
    expect(await markStalled(db.pool, 100)).toEqual([id]);
    expect((await row(id)).status).toBe("upload_failed");
    // a redelivered start and a second sweep do not revive it
    expect(await startUpload(db.pool, id, ctx())).toEqual({ started: false, reason: "not_publish_approved" });
    expect(await markStalled(db.pool, 100)).toEqual([]);
    expect((await row(id)).status).toBe("upload_failed");
  });
});

describe("manualRetry", () => {
  async function failed(): Promise<string> {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await reportProgress(db.pool, id, 1, 700);
    await finishUpload(db.pool, id, 1, { kind: "failed", reason: "network" });
    return id;
  }

  it("manual_retry_requires_matching_approval", async () => {
    const id = await failed();
    expect(await manualRetry(db.pool, id, rctx({ currentApprovalHash: "new" }))).toEqual({ started: false, reason: "approval_changed" });
    expect(await manualRetry(db.pool, id, rctx({ currentFileSha: "new" }))).toEqual({ started: false, reason: "file_changed" });
    expect((await row(id)).status).toBe("upload_failed");
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: true, attempt: 2 });
    expect(await row(id)).toMatchObject({ status: "uploading", bytes_sent: "0", failure_reason: null, finished_at: null });
    expect(await logs(id)).toEqual(["started", "failed", "manual_retry"]);
  });

  it("manual_retry_only_from_upload_failed", async () => {
    const id = await newUpload();
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: false, reason: "not_upload_failed" });
    await startUpload(db.pool, id, ctx());
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: false, reason: "not_upload_failed" });
  });

  it("manual_retry_rechecks_caps", async () => {
    const id = await failed();
    await newUpload({ status: "uploaded", startedAgoMs: 10, channel: "chan" });
    expect(await manualRetry(db.pool, id, rctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
    expect(await manualRetry(db.pool, id, rctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } }))).toEqual({ started: false, reason: "spacing" });
    expect(await manualRetry(db.pool, id, rctx({ caps: { ...CAPS, dailyQuotaUnits: 1, costUnits: 1 } }))).toEqual({ started: false, reason: "quota" });
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("no_automatic_retry_function_exists", () => {
    // Every export that could move a row is on this allow-list; only manualRetry may leave upload_failed.
    expect(Object.keys(uploadsModule).sort()).toEqual(
      ["DUPLICATE_SKIPPED_REASON", "STALLED_REASON", "STUDIO_FIRST_PREFIX", "finishUpload", "manualRetry", "markStalled", "reportProgress", "startUpload"].sort(),
    );
  });
});

describe("job handling", () => {
  it("queue_option_attempts_is_one", async () => {
    const name = `uq-${process.pid}`;
    const queue = createJobQueue(db.redisUrl, "uploads", name, { keepFailed: 7 });
    const inspect = new Queue(`uploads-${name}`, { connection: { url: db.redisUrl } });
    try {
      const id = uuidv7();
      const jobId = await queue.enqueueUpload(id);
      const job = await inspect.getJob(jobId);
      expect(job?.opts.attempts).toBe(1);
      expect(job?.opts.removeOnFail).toEqual({ count: 7 });
      expect(job?.name).toBe("upload");
      // same id again does not create a second job
      await queue.enqueueUpload(id);
      expect(await inspect.getJobCountByTypes("waiting")).toBe(1);
    } finally {
      await inspect.close();
      await queue.close();
    }
  });

  it("handler_noops_when_not_started_and_finishes_when_started", async () => {
    let calls = 0;
    const deps = {
      startCtx: () => ctx(),
      uploader: {
        async upload(_id: string, onProgress: (n: number) => Promise<void>) {
          calls++;
          await onProgress(5);
          return { kind: "uploaded", youtubeId: "yt42" } as const;
        },
      },
    };
    const id = await newUpload();
    expect(await handleUploadJob(db.pool, deps, id)).toEqual({ started: true });
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "yt42", bytes_sent: "5" });
    expect(await handleUploadJob(db.pool, deps, id)).toEqual({ started: false });
    expect(calls).toBe(1);
    // an uploader that throws is a recorded failure, never a retry
    const bad = await newUpload();
    await handleUploadJob(db.pool, { ...deps, uploader: { upload: async () => { throw new Error("quota exceeded"); } } }, bad);
    expect(await row(bad)).toMatchObject({ status: "upload_failed", failure_reason: "quota exceeded" });
  });

  it("crash_mid_upload_leaves_uploading_until_stall_detection", async () => {
    const id = await newUpload();
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./helpers/upload-process.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, DATABASE_URL: db.pool.options.connectionString!, UPLOAD_ID: id },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    try {
      await waitFor(() => (out.includes("PROGRESS") ? true : child.exitCode !== null ? Promise.reject(new Error(out)) : false), "child progress");
      child.kill("SIGKILL");
      await exited;
      expect(await row(id)).toMatchObject({ status: "uploading", bytes_sent: "1234" });
      expect(await markStalled(db.pool, 60_000)).toEqual([]); // fresh progress: left alone
      await new Promise((r) => setTimeout(r, 200));
      expect(await markStalled(db.pool, 100)).toEqual([id]);
      expect((await row(id)).status).toBe("upload_failed");
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });
});

// ---- fix round 1: attempt token, abort, late success, guards -------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const deps = (upload: UploadJobDeps["uploader"]["upload"]): UploadJobDeps => ({ startCtx: () => ctx(), uploader: { upload } });
async function startedStalled(o: { videoId?: string } = {}): Promise<string> {
  const id = await newUpload(o);
  await startUpload(db.pool, id, ctx());
  await sleep(30);
  expect(await markStalled(db.pool, 10)).toEqual([id]);
  return id;
}

describe("attempt token", () => {
  it("stale_attempt_progress_and_finish_are_rejected_after_retry", async () => {
    const id = await startedStalled();
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: true, attempt: 2 });
    expect(await reportProgress(db.pool, id, 1, 50)).toBe(false);
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "OLD" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "uploading", youtube_id: null, bytes_sent: "0", attempt: 2 });
    expect(await reportProgress(db.pool, id, 2, 50)).toBe(true);
    expect(await finishUpload(db.pool, id, 2, { kind: "uploaded", youtubeId: "NEW" })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "NEW" });
  });

  it("uploader_is_aborted_when_row_is_stalled", async () => {
    const id = await newUpload();
    let signal!: AbortSignal;
    let gate!: () => void;
    const gated = new Promise<void>((r) => (gate = r));
    let reported = false;
    const job = handleUploadJob(db.pool, deps(async (_id, onProgress, sig) => {
      signal = sig;
      await onProgress(10);
      reported = true;
      await gated;
      await onProgress(20); // superseded: must throw
      throw new Error("unreachable: onProgress should have thrown");
    }), id);
    await waitFor(() => reported, "first progress");
    await sleep(30);
    expect(await markStalled(db.pool, 10)).toEqual([id]);
    gate();
    expect(await job).toEqual({ started: true }); // normal stop, not a throw
    expect(signal.aborted).toBe(true);
    expect(await row(id)).toMatchObject({ status: "upload_failed", failure_reason: "no progress: check YouTube Studio first", bytes_sent: "10" });
  });

  it("progress_above_total_is_rejected", async () => {
    const id = await newUpload(); // bytes_total 1_000_000
    await startUpload(db.pool, id, ctx());
    expect(await reportProgress(db.pool, id, 1, 900)).toBe(true);
    expect(await reportProgress(db.pool, id, 1, 1_000_001)).toBe(false);
    expect(await row(id)).toMatchObject({ bytes_sent: "900" });
    expect(await reportProgress(db.pool, id, 1, 1_000_000)).toBe(true);
  });
});

describe("late success", () => {
  it("late_success_after_stall_is_recorded_not_dropped", async () => {
    const id = await startedStalled();
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "LATE" })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "LATE", failure_reason: null });
    expect((await row(id)).finished_at).not.toBeNull();
    expect((await logs(id)).some((e) => /^late_success youtube_id=LATE$/.test(e))).toBe(true);
  });

  it("late_success_conflict_with_sibling_keeps_failed_but_stores_youtube_id", async () => {
    const video = uuidv7();
    const a = await startedStalled({ videoId: video });
    const b = await newUpload({ videoId: video, status: "uploading", startedAgoMs: 10, channel: "other" });
    expect(await finishUpload(db.pool, a, 1, { kind: "uploaded", youtubeId: "LIVE" })).toBe(false);
    expect(await row(a)).toMatchObject({ status: "upload_failed", youtube_id: "LIVE" });
    expect((await row(b)).status).toBe("uploading");
    expect((await logs(a)).some((e) => /^late_success_conflict youtube_id=LIVE$/.test(e))).toBe(true);
  });

  it("finish_rejected_is_logged_with_youtube_id", async () => {
    const id = await newUpload(); // never started
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "ZZ9" })).toBe(false);
    expect((await logs(id)).some((e) => e.startsWith("finish_rejected") && e.includes("ZZ9"))).toBe(true);
    expect(await finishUpload(db.pool, id, 1, { kind: "failed", reason: "x" })).toBe(false);
    expect((await logs(id)).filter((e) => e.startsWith("finish_rejected"))).toHaveLength(2);
  });
});

describe("retry and sibling guards", () => {
  it("manual_retry_requires_human_confirmation_flag", async () => {
    const id = await startedStalled();
    const noFlag = ctx() as unknown as Parameters<typeof manualRetry>[2];
    expect(await manualRetry(db.pool, id, noFlag)).toEqual({ started: false, reason: "human_confirmation_required" });
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("manual_retry_refused_when_youtube_id_known", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await finishUpload(db.pool, id, 1, { kind: "duplicate_skipped", youtubeId: "yt-dup" });
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: false, reason: "already_on_youtube" });
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("sibling_row_cannot_start_while_other_is_stalled_unresolved", async () => {
    const video = uuidv7();
    await startedStalled({ videoId: video });
    const b = await newUpload({ videoId: video, channel: "c-b" });
    expect(await startUpload(db.pool, b, ctx())).toEqual({ started: false, reason: "unresolved_sibling_upload" });
    // a sibling that only has a youtube_id blocks too
    const v2 = uuidv7();
    const d = await newUpload({ videoId: v2, status: "upload_failed", channel: "c-d" });
    await db.pool.query("update uploads set youtube_id = 'known' where id = $1", [d]);
    const e = await newUpload({ videoId: v2, channel: "c-e" });
    expect(await startUpload(db.pool, e, ctx())).toEqual({ started: false, reason: "unresolved_sibling_upload" });
    expect(await manualRetry(db.pool, b, rctx())).toEqual({ started: false, reason: "not_upload_failed" });
  });

  it("manual_retry_blocked_by_unresolved_sibling", async () => {
    const video = uuidv7();
    const a = await startedStalled({ videoId: video });
    const b = await newUpload({ videoId: video, status: "upload_failed", channel: "c-b", startedAgoMs: 5000 });
    expect(await manualRetry(db.pool, a, rctx())).toEqual({ started: false, reason: "unresolved_sibling_upload" });
    expect((await row(b)).status).toBe("upload_failed");
  });
});

describe("counting and isolation", () => {
  it("failed_started_rows_count_toward_spacing_and_daily_cap", async () => {
    await newUpload({ status: "upload_failed", startedAgoMs: 10 });
    const id = await newUpload();
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } }))).toEqual({ started: false, reason: "spacing" });
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, dailyQuotaUnits: 1, costUnits: 1 } }))).toEqual({ started: false, reason: "quota" });
  });

  it("quota_day_is_pacific", async () => {
    const LA = "'America/Los_Angeles'";
    const midnight = `(date_trunc('day', clock_timestamp() at time zone ${LA}) at time zone ${LA})`;
    const old = await newUpload({ status: "uploaded", channel: "chan" });
    await db.pool.query(`update uploads set started_at = ${midnight} - interval '1 minute' where id = $1`, [old]);
    const id = await newUpload();
    // started the previous Pacific day: does not count today
    expect(await startUpload(db.pool, id, ctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: true, attempt: 1 });
    await db.pool.query("update uploads set status = 'upload_failed' where id = $1", [id]);
    await db.pool.query(`update uploads set started_at = ${midnight} where id = $1`, [id]);
    const next = await newUpload({ channel: "chan" });
    // started exactly at Pacific midnight: counts
    expect(await startUpload(db.pool, next, ctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
  });

  it("repeatable_read_default_still_serialises_per_channel", async () => {
    const rr = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 10, options: "-c default_transaction_isolation=repeatable\\ read" });
    try {
      expect((await rr.query("show default_transaction_isolation")).rows[0].default_transaction_isolation).toBe("repeatable read");
      const spaced = ctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } });
      for (let round = 0; round < 20; round++) {
        await db.reset();
        const a = await newUpload();
        const b = await newUpload();
        const rs = await Promise.all([startUpload(rr, a, spaced), startUpload(rr, b, spaced)]);
        expect(rs.filter((r) => r.started)).toHaveLength(1);
      }
    } finally {
      await rr.end();
    }
  });

  it("caller_client_in_repeatable_read_is_refused", async () => {
    const id = await newUpload();
    const client = await db.pool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      expect(await startUpload(client, id, ctx())).toEqual({ started: false, reason: "isolation_not_read_committed" });
      await client.query("rollback");
      await client.query("begin isolation level read committed");
      expect(await startUpload(client, id, ctx())).toEqual({ started: true, attempt: 1 });
      await client.query("commit");
    } finally {
      client.release();
    }
  });
});

describe("executor", () => {
  it("uploader_throw_after_bytes_has_studio_prefix", async () => {
    const id = await newUpload();
    await handleUploadJob(db.pool, deps(async (_i, onProgress) => {
      await onProgress(100);
      throw new Error("connection reset");
    }), id);
    expect((await row(id)).failure_reason).toBe("check YouTube Studio first: connection reset");
    const long = await newUpload();
    await handleUploadJob(db.pool, deps(async (_i, onProgress) => {
      await onProgress(100);
      throw new Error("e".repeat(500));
    }), long);
    const r = (await row(long)).failure_reason as string;
    expect([...r]).toHaveLength(200);
    expect(r.startsWith("check YouTube Studio first: ")).toBe(true);
  });

  it("retried_row_is_actually_run_end_to_end", async () => {
    const id = await newUpload();
    await handleUploadJob(db.pool, deps(async () => { throw new Error("early"); }), id);
    expect(await row(id)).toMatchObject({ status: "upload_failed", failure_reason: "early" });
    const r = await manualRetry(db.pool, id, rctx());
    expect(r).toEqual({ started: true, attempt: 2 });
    await runUpload(db.pool, deps(async (_i, onProgress) => {
      await onProgress(77);
      return { kind: "uploaded", youtubeId: "retried-yt" };
    }), id, 2);
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "retried-yt", bytes_sent: "77", attempt: 2 });
  });

  it("upload_queue_route_end_to_end", async () => {
    const name = `route-${process.pid}`; // upload jobs live on their own queue, never beside a stage worker
    const queue = createJobQueue(db.redisUrl, "uploads", name);
    const id = await newUpload();
    const uploadWorker = queue.startWorker((uploadId) =>
      handleUploadJob(db.pool, deps(async (_i, onProgress) => {
        await onProgress(5);
        return { kind: "uploaded", youtubeId: "via-queue" };
      }), uploadId).then(() => {}),
    );
    try {
      await queue.enqueueUpload(id);
      await waitFor(async () => (await row(id)).status === "uploaded", "upload via queue");
      expect(await row(id)).toMatchObject({ youtube_id: "via-queue", attempt: 1 });
    } finally {
      await uploadWorker.close();
      await queue.close();
    }
  });
});

describe("retry caps (round 1b)", () => {
  async function failedOnce(): Promise<string> {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await finishUpload(db.pool, id, 1, { kind: "failed", reason: "net" });
    return id;
  }
  const tight = { ...CAPS, maxPerDay: 1, minSpacingMs: 3_600_000 };

  it("manual_retry_is_not_blocked_by_its_own_earlier_start", async () => {
    const id = await failedOnce();
    expect(await manualRetry(db.pool, id, rctx({ caps: tight }))).toEqual({ started: true, attempt: 2 });
  });

  it("manual_retry_still_counts_its_earlier_attempts_toward_quota", async () => {
    const id = await failedOnce();
    const q2 = { ...CAPS, dailyQuotaUnits: 2, costUnits: 1 };
    expect(await manualRetry(db.pool, id, rctx({ caps: q2 }))).toEqual({ started: true, attempt: 2 }); // 1 used + 1 <= 2
    await finishUpload(db.pool, id, 2, { kind: "failed", reason: "net" });
    expect(await manualRetry(db.pool, id, rctx({ caps: q2 }))).toEqual({ started: false, reason: "quota" }); // 2 used + 1 > 2
  });

  it("retry_is_still_blocked_by_other_rows_spacing_and_cap", async () => {
    const id = await failedOnce();
    await newUpload({ status: "uploaded", startedAgoMs: 10, channel: "chan" });
    expect(await manualRetry(db.pool, id, rctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
    expect(await manualRetry(db.pool, id, rctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } }))).toEqual({ started: false, reason: "spacing" });
  });
});

describe("queue kinds (round 1b)", () => {
  it("queue_kind_and_suffix_validation", async () => {
    expect(() => createJobQueue(db.redisUrl, "other" as never)).toThrow(RangeError);
    for (const bad of ["", "UPPER", "has space", "a.b", "a:b", "x".repeat(41)]) {
      expect(() => createJobQueue(db.redisUrl, "stages", bad)).toThrow(RangeError);
    }
    const q = createJobQueue(db.redisUrl, "uploads", "ok-1");
    const bare = createJobQueue(db.redisUrl, "stages");
    expect([q.name, bare.name]).toEqual(["uploads-ok-1", "stages"]);
    await q.close();
    await bare.close();
  });

  it("stage_enqueue_on_uploads_queue_throws", async () => {
    const q = createJobQueue(db.redisUrl, "uploads", `k1-${process.pid}`);
    try {
      expect(() => (q as unknown as StageQueue).enqueue(uuidv7(), 0, 0, "h")).toThrow(/not available on a 'uploads' queue/);
    } finally {
      await q.close();
    }
  });

  it("upload_enqueue_on_stages_queue_throws", async () => {
    const q = createJobQueue(db.redisUrl, "stages", `k2-${process.pid}`);
    try {
      expect(() => (q as unknown as UploadQueue).enqueueUpload(uuidv7())).toThrow(/not available on a 'stages' queue/);
    } finally {
      await q.close();
    }
  });

  it("stage_worker_never_sees_upload_jobs", async () => {
    const sq = createJobQueue(db.redisUrl, "stages", `k3-${process.pid}`);
    const uq = createJobQueue(db.redisUrl, "uploads", `k3-${process.pid}`);
    const stageSeen: string[] = [];
    const uploadSeen: string[] = [];
    const w1 = sq.startWorker(async (job) => void stageSeen.push(job.stageRunId), { onError: () => {} });
    const w2 = uq.startWorker(async (uploadId) => void uploadSeen.push(uploadId), { onError: () => {} });
    try {
      const stageId = uuidv7();
      const uploadId = uuidv7();
      await sq.enqueue(stageId, 0, 0, "h");
      await uq.enqueueUpload(uploadId);
      await waitFor(() => stageSeen.length === 1 && uploadSeen.length === 1, "both jobs delivered");
      await sleep(200);
      expect(stageSeen).toEqual([stageId]);
      expect(uploadSeen).toEqual([uploadId]);
    } finally {
      await w1.close();
      await w2.close();
      await sq.close();
      await uq.close();
    }
  });
});

// ---- fix round 2 -----------------------------------------------------------------------------------------------
describe("sibling lock (round 2)", () => {
  it("sibling_start_waits_for_concurrent_markStalled_and_is_refused", async () => {
    for (let round = 0; round < 20; round++) {
      await db.reset();
      const video = uuidv7();
      const a = await newUpload({ videoId: video, status: "uploading", startedAgoMs: 60_000, channel: "ca" });
      const b = await newUpload({ videoId: video, channel: "cb" });
      const c = await db.pool.connect();
      try {
        await c.query("begin");
        expect(await markStalled(c, 30_000)).toEqual([a]); // a is upload_failed but NOT committed
        const start = startUpload(db.pool, b, ctx());
        await sleep(60); // b is now waiting on a's row lock (or, unfixed, already past the sibling check)
        await c.query("commit");
        expect(await start).toEqual({ started: false, reason: "unresolved_sibling_upload" });
      } finally {
        c.release();
      }
      expect((await row(b)).status).toBe("publish_approved");
    }
  });

  it("two_siblings_starting_together_do_not_deadlock", async () => {
    for (let round = 0; round < 20; round++) {
      await db.reset();
      const video = uuidv7();
      const a = await newUpload({ videoId: video, channel: "ca" });
      const b = await newUpload({ videoId: video, channel: "cb" });
      const rs = await Promise.all(round % 2 ? [startUpload(db.pool, a, ctx()), startUpload(db.pool, b, ctx())] : [startUpload(db.pool, b, ctx()), startUpload(db.pool, a, ctx())]);
      expect(rs.filter((r) => r.started)).toHaveLength(1);
      expect(rs.find((r) => !r.started)).toMatchObject({ started: false });
    }
  });
});

describe("late success tightening (round 2)", () => {
  it("stale_attempt_late_success_is_rejected_after_second_stall", async () => {
    const id = await startedStalled();
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: true, attempt: 2 });
    await sleep(30);
    expect(await markStalled(db.pool, 10)).toEqual([id]);
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "OLD1" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "upload_failed", youtube_id: null, attempt: 2 });
    expect((await logs(id)).some((e) => e.startsWith("finish_rejected") && e.includes("youtube_id=OLD1"))).toBe(true);
    // the current attempt's own late success still works
    expect(await finishUpload(db.pool, id, 2, { kind: "uploaded", youtubeId: "NEW2" })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "NEW2" });
  });

  it("late_success_cannot_overwrite_a_recorded_youtube_id", async () => {
    const id = await startedStalled();
    await db.pool.query("update uploads set youtube_id = 'KNOWN' where id = $1", [id]);
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "OTHER" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "upload_failed", youtube_id: "KNOWN" });
    expect((await logs(id)).some((e) => e.includes("youtube_id=OTHER"))).toBe(true);
  });

  it("duplicate_skipped_row_is_not_eligible_for_late_success", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, 1, { kind: "duplicate_skipped" })).toBe(true);
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "LATE" })).toBe(false);
    expect(await row(id)).toMatchObject({ status: "upload_failed", youtube_id: null });
  });

  it("uploader_supplied_reason_cannot_forge_late_success_eligibility", async () => {
    for (const forged of ["check YouTube Studio first: pretend", STALLED_REASON, "check YouTube Studio first"]) {
      const id = await newUpload({ channel: `forge-${forged.length}` });
      await handleUploadJob(db.pool, deps(async (_i, onProgress) => {
        await onProgress(10);
        return { kind: "failed", reason: forged };
      }), id);
      expect((await row(id)).failure_reason).toBe(`uploader said: ${forged}`);
      expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "FORGED" })).toBe(false);
      expect((await row(id)).status).toBe("upload_failed");
    }
  });

  it("attempt_above_int4_is_rejected", async () => {
    const id = await newUpload();
    await expect(reportProgress(db.pool, id, 2147483648, 1)).rejects.toThrow(RangeError);
    await expect(finishUpload(db.pool, id, 2147483648, { kind: "failed", reason: "x" })).rejects.toThrow(RangeError);
  });

  it("finish_is_read_committed_even_with_a_repeatable_read_default", async () => {
    const rr = new pg.Pool({ connectionString: db.pool.options.connectionString, max: 5, options: "-c default_transaction_isolation=repeatable\\ read" });
    try {
      for (let round = 0; round < 10; round++) {
        await db.reset();
        const id = await newUpload({ status: "uploading", startedAgoMs: 60_000 });
        const c = await db.pool.connect();
        try {
          await c.query("begin");
          expect(await markStalled(c, 30_000)).toEqual([id]); // uncommitted stall
          const fin = finishUpload(rr, id, 0, { kind: "uploaded", youtubeId: "KEEP" });
          await sleep(60);
          await c.query("commit");
          expect(await fin).toBe(true); // never a serialization error, id never thrown away
        } finally {
          c.release();
        }
        expect(await row(id)).toMatchObject({ status: "uploaded", youtube_id: "KEEP" });
      }
    } finally {
      await rr.end();
    }
  });
});

describe("logged youtube id blocks retry (round 2)", () => {
  async function rejectedOldAttempt(): Promise<string> {
    const id = await startedStalled();
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: true, attempt: 2 });
    expect(await finishUpload(db.pool, id, 1, { kind: "uploaded", youtubeId: "LIVE-OLD" })).toBe(false); // logged only
    expect(await finishUpload(db.pool, id, 2, { kind: "failed", reason: "net" })).toBe(true);
    return id;
  }

  it("retry_refused_when_rejected_stale_attempt_logged_a_youtube_id", async () => {
    const id = await rejectedOldAttempt();
    expect(await manualRetry(db.pool, id, rctx())).toEqual({ started: false, reason: "youtube_id_known_in_log" });
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("retry_allowed_with_explicit_override_flags", async () => {
    const id = await rejectedOldAttempt();
    const ctxBoth = { ...rctx(), ignoreLoggedYoutubeId: true as const };
    expect(await manualRetry(db.pool, id, { ...ctxBoth, humanConfirmedNotOnYouTube: undefined as never })).toEqual({ started: false, reason: "human_confirmation_required" });
    expect(await manualRetry(db.pool, id, ctxBoth)).toEqual({ started: true, attempt: 3 });
  });

  it("sibling_log_only_youtube_id_blocks_start", async () => {
    const video = uuidv7();
    const a = await newUpload({ videoId: video, channel: "ca" });
    await finishUpload(db.pool, a, 1, { kind: "uploaded", youtubeId: "SIB-LIVE" }); // rejected: logged only
    const b = await newUpload({ videoId: video, channel: "cb" });
    expect(await startUpload(db.pool, b, ctx())).toEqual({ started: false, reason: "youtube_id_known_in_log" });
  });
});
