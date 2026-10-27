import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestDb, type TestDb } from "../support/db";
import { createLogSink, stageLogPath, TRUNCATED_MARKER } from "@/server/logs/log-sink";
import { openStageLog } from "@/server/logs/stage-log";
import { createStageContext } from "@/server/core/stage-handler";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "logsink-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const V = "11111111-1111-4111-8111-111111111111";

describe("createLogSink", () => {
  it("log_stops_at_the_cap_with_a_marker", async () => {
    const file = path.join(dir, "logs", "draft-1.log");
    const sink = createLogSink(file, 100);
    for (let i = 0; i < 50; i++) sink.write(`line number ${i}`);
    await sink.close();
    const text = await readFile(file, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100 + TRUNCATED_MARKER.length + 1);
    expect(text.trimEnd().split("\n").at(-1)).toBe(TRUNCATED_MARKER);
    expect(text.match(/\[log truncated\]/g)).toHaveLength(1);
    expect(text).not.toContain("line number 49");
  });

  it("full_disk_does_not_throw_into_the_stage", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const enospc = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const sink = createLogSink(path.join(dir, "x.log"), 1000, { mkdir: async () => {}, append: async () => { throw enospc; } });
    expect(() => { sink.write("a"); sink.write("b"); }).not.toThrow();
    await expect(sink.close()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1); // once, then quiet
    expect(String(err.mock.calls[0]![0])).not.toContain("no space"); // code only, no message or line content
  });

  it("an_unwritable_location_is_quiet_too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const blocker = path.join(dir, "file");
    await writeFile(blocker, "x");
    const sink = createLogSink(path.join(blocker, "sub", "x.log"), 1000); // parent is a file
    sink.write("hello");
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it("log_path_is_built_only_from_plain_ids", () => {
    expect(stageLogPath("/r", V, "draft", 2)).toBe(`/r/videos/${V}/logs/draft-2.log`);
    expect(stageLogPath("/r", "../etc", "draft", 1)).toBeNull();
    expect(stageLogPath("/r", V, "../x", 1)).toBeNull();
    expect(stageLogPath("/r", V, "draft", -1)).toBeNull();
  });
});

describe("ctx.log through a stage log", () => {
  let db: TestDb;
  beforeAll(async () => { db = await withTestDb(); });
  afterAll(async () => { await db?.stop(); });
  beforeEach(async () => { await db.reset(); });

  it("writes_redacted_compacted_lines_to_the_file_and_batches_log_events", async () => {
    const log = openStageLog({ db: db.pool, storageRoot: dir, capBytes: 10_000, flushMs: 50 }, { videoId: V, stageRunId: "22222222-2222-4222-8222-222222222222", stageName: "draft", fence: 3 });
    const { ctx } = createStageContext({
      stage: { id: "s", name: "draft", inputHash: "h" }, claim: {} as never, config: {} as never, signal: new AbortController().signal, paid: {} as never,
      log: (l) => log.write(l),
    });
    ctx.log("calling with sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    ctx.log(JSON.stringify({ blob: "A".repeat(20_000) }));
    ctx.log("plain");
    await log.close();
    const text = await readFile(path.join(dir, "videos", V, "logs", "draft-3.log"), "utf8");
    expect(text).not.toContain("sk-ant");
    expect(text).toContain("plain");
    expect(Buffer.byteLength(text)).toBeLessThan(5000);
    const { rows } = await db.pool.query("select type, payload from events order by id");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.type === "log")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("sk-ant");
  });

  it("log_events_are_at_most_one_per_second_per_run", async () => {
    const log = openStageLog({ db: db.pool, storageRoot: dir, capBytes: 10_000, flushMs: 400 }, { videoId: V, stageRunId: "22222222-2222-4222-8222-222222222222", stageName: "tts", fence: 1 });
    for (let i = 0; i < 200; i++) log.write(`line ${i}`);
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 200; i < 400; i++) log.write(`line ${i}`);
    await log.close();
    const { rows } = await db.pool.query("select payload from events order by id");
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.flatMap((r) => r.payload.lines as string[]).length + rows.reduce((n, r) => n + (r.payload.dropped ?? 0), 0)).toBe(400);
  });

  it("a_missing_video_id_still_logs_to_the_feed_without_a_file", async () => {
    const log = openStageLog({ db: db.pool, storageRoot: dir, capBytes: 1000, flushMs: 10 }, { videoId: null, stageRunId: "22222222-2222-4222-8222-222222222222", stageName: "tts", fence: 1 });
    log.write("hello");
    await log.close();
    expect((await db.pool.query("select count(*)::int n from events")).rows[0].n).toBe(1);
  });
});
