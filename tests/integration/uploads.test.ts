import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Queue } from "bullmq";
import { createJobQueue } from "@/server/queue/job-queue";
import * as uploadsModule from "@/server/db/uploads";
import { finishUpload, manualRetry, markStalled, reportProgress, startUpload, type StartCtx } from "@/server/db/uploads";
import { handleUploadJob } from "@/server/db/upload-job";
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
    expect(await startUpload(db.pool, id, ctx())).toEqual({ started: true });
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
    expect(await finishUpload(db.pool, id, { kind: "uploaded", youtubeId: "yt1" })).toBe(true);
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
    expect(await startUpload(db.pool, a, ctx())).toEqual({ started: true });
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
    expect(await reportProgress(db.pool, id, 10)).toBe(false); // not uploading yet
    await startUpload(db.pool, id, ctx());
    expect(await reportProgress(db.pool, id, 500)).toBe(true);
    expect(await reportProgress(db.pool, id, 400)).toBe(false);
    expect(await reportProgress(db.pool, id, 500)).toBe(true);
    expect(await row(id)).toMatchObject({ bytes_sent: "500" });
    await expect(reportProgress(db.pool, id, -1)).rejects.toThrow(RangeError);
    await expect(reportProgress(db.pool, id, 1.5)).rejects.toThrow(RangeError);
  });

  it("finish_only_from_uploading", async () => {
    const id = await newUpload();
    expect(await finishUpload(db.pool, id, { kind: "uploaded", youtubeId: "x" })).toBe(false);
    expect(await finishUpload(db.pool, id, { kind: "failed", reason: "x" })).toBe(false);
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, { kind: "failed", reason: "boom\u0000\ud800" + "x".repeat(300) })).toBe(true);
    const r = await row(id);
    expect(r.status).toBe("upload_failed");
    expect([...r.failure_reason]).toHaveLength(200);
    expect(r.failure_reason).not.toContain("\u0000");
    expect(await finishUpload(db.pool, id, { kind: "uploaded", youtubeId: "late" })).toBe(false);
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("duplicate_skipped_counts_as_failure", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    expect(await finishUpload(db.pool, id, { kind: "duplicate_skipped", youtubeId: "yt9" })).toBe(true);
    expect(await row(id)).toMatchObject({ status: "upload_failed", failure_reason: "duplicate_skipped: check YouTube Studio", youtube_id: "yt9" });
  });

  it("bigint_columns_convert_safely", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    await expect(reportProgress(db.pool, id, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(RangeError);
    expect(await reportProgress(db.pool, id, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect((await row(id)).bytes_sent).toBe(String(Number.MAX_SAFE_INTEGER));
    // an out-of-range count already stored cannot be silently truncated into the cap check
    await db.pool.query("update uploads set started_at = clock_timestamp() where id = $1", [id]);
    const other = await newUpload();
    expect(await startUpload(db.pool, other, ctx())).toEqual({ started: true }); // count (bigint string) converted
  });
});

describe("stall detection", () => {
  it("slow_but_progressing_upload_is_never_marked_failed", async () => {
    const id = await newUpload();
    await startUpload(db.pool, id, ctx());
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 120));
      expect(await reportProgress(db.pool, id, i * 10)).toBe(true);
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
    await reportProgress(db.pool, id, 700);
    await finishUpload(db.pool, id, { kind: "failed", reason: "network" });
    return id;
  }

  it("manual_retry_requires_matching_approval", async () => {
    const id = await failed();
    expect(await manualRetry(db.pool, id, ctx({ currentApprovalHash: "new" }))).toEqual({ started: false, reason: "approval_changed" });
    expect(await manualRetry(db.pool, id, ctx({ currentFileSha: "new" }))).toEqual({ started: false, reason: "file_changed" });
    expect((await row(id)).status).toBe("upload_failed");
    expect(await manualRetry(db.pool, id, ctx())).toEqual({ started: true });
    expect(await row(id)).toMatchObject({ status: "uploading", bytes_sent: "0", failure_reason: null, finished_at: null });
    expect(await logs(id)).toEqual(["started", "failed", "manual_retry"]);
  });

  it("manual_retry_only_from_upload_failed", async () => {
    const id = await newUpload();
    expect(await manualRetry(db.pool, id, ctx())).toEqual({ started: false, reason: "not_upload_failed" });
    await startUpload(db.pool, id, ctx());
    expect(await manualRetry(db.pool, id, ctx())).toEqual({ started: false, reason: "not_upload_failed" });
  });

  it("manual_retry_rechecks_caps", async () => {
    const id = await failed();
    await newUpload({ status: "uploaded", startedAgoMs: 10, channel: "chan" });
    expect(await manualRetry(db.pool, id, ctx({ caps: { ...CAPS, maxPerDay: 1 } }))).toEqual({ started: false, reason: "daily_cap" });
    expect(await manualRetry(db.pool, id, ctx({ caps: { ...CAPS, minSpacingMs: 3_600_000 } }))).toEqual({ started: false, reason: "spacing" });
    expect(await manualRetry(db.pool, id, ctx({ caps: { ...CAPS, dailyQuotaUnits: 1, costUnits: 1 } }))).toEqual({ started: false, reason: "quota" });
    expect((await row(id)).status).toBe("upload_failed");
  });

  it("no_automatic_retry_function_exists", () => {
    // Every export that could move a row is on this allow-list; only manualRetry may leave upload_failed.
    expect(Object.keys(uploadsModule).sort()).toEqual(
      ["DUPLICATE_SKIPPED_REASON", "STALLED_REASON", "finishUpload", "manualRetry", "markStalled", "reportProgress", "startUpload"].sort(),
    );
  });
});

describe("job handling", () => {
  it("queue_option_attempts_is_one", async () => {
    const name = `uploads-${process.pid}`;
    const queue = createJobQueue(db.redisUrl, name, { keepFailed: 7 });
    const inspect = new Queue(name, { connection: { url: db.redisUrl } });
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
