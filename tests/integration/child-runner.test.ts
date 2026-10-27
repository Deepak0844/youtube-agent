import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runChild, ChildError, type ChildSpec } from "@/server/render/child";
import { argsHash, commandLabelOf, readProcInfo } from "@/server/render/proc-info";
import { createChildRegistry, holdWorkerLock, sweepOrphans } from "@/server/db/child-processes";
import { uuidv7 } from "@/server/core/ids";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
let tmp: string;
beforeAll(async () => {
  db = await withTestDb();
  tmp = await mkdtemp(path.join(os.tmpdir(), "child-runner-"));
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const NODE = process.execPath;
const sid = () => uuidv7();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}
function spec(over: Partial<ChildSpec> & Pick<ChildSpec, "args">): ChildSpec {
  return {
    command: NODE,
    cwd: tmp,
    timeoutMs: 20_000,
    maxOutputBytes: 1 << 20,
    signal: new AbortController().signal,
    stageRunId: sid(),
    ...over,
  };
}
const deps = (workerId = "w1") => ({ registry: createChildRegistry(db.pool, workerId), killGraceMs: 300 });
const rows = async () => (await db.pool.query("select * from child_processes")).rows;

describe("runChild", () => {
  it("runs_and_returns_the_exit_code_and_lines", async () => {
    const lines: string[] = [];
    const r = await runChild(spec({ args: ["-e", "console.log('a'); console.error('b'); process.exit(3)"], onLine: (l) => lines.push(l) }), deps());
    expect(r).toMatchObject({ code: 3, signal: null, truncated: false, timedOut: false, aborted: false });
    expect(lines.sort()).toEqual(["a", "b"]);
    expect(await rows()).toHaveLength(0); // unregistered afterwards
  });

  it("registers_the_child_while_it_runs", async () => {
    const ac = new AbortController();
    const p = runChild(spec({ args: ["-e", "setTimeout(()=>{},60000)"], signal: ac.signal }), deps());
    await waitFor(async () => (await rows()).length === 1);
    const [row] = await rows();
    expect(row.command_label).toBe(path.basename(NODE));
    expect(row.worker_id).toBe("w1");
    expect(alive(Number(row.pid))).toBe(true);
    ac.abort();
    await p;
    expect(await rows()).toHaveLength(0);
  });

  it("heartbeat_keeps_ticking_while_a_child_burns_cpu", async () => {
    // Warm up so one-off JIT/GC cost is not counted, then judge the 99th percentile of timer lag over a 1.5 s burn
    // (a single scheduler hiccup on a busy CI box must not fail the test; a blocked loop would fail every sample).
    await runChild(spec({ args: ["-e", "0"] }), deps());
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const r = await runChild(spec({ args: ["-e", "const e=Date.now()+1500; while(Date.now()<e){}"] }), deps());
    h.disable();
    expect(r.code).toBe(0);
    expect(h.percentile(99) / 1e6).toBeLessThan(100); // ms
    expect(h.mean / 1e6).toBeLessThan(50);
  });

  it("a_grandchild_left_behind_by_a_normally_exiting_child_is_killed", async () => {
    const pidFile = path.join(tmp, "left-behind.pid");
    const code = `const {spawn}=require('child_process');const g=spawn('sleep',['300'],{stdio:'ignore'});g.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid))`;
    const r = await runChild(spec({ args: ["-e", code] }), deps());
    expect(r).toMatchObject({ code: 0, aborted: false, timedOut: false });
    const gpid = Number(await readFile(pidFile, "utf8"));
    await waitFor(() => !alive(gpid), 3000);
  });

  it("a_stalled_registry_cannot_hang_the_run_and_the_child_is_stopped", async () => {
    const hang = { register: () => new Promise<void>(() => undefined), unregister: async () => undefined };
    const t0 = Date.now();
    await expect(runChild(spec({ args: ["-e", "setInterval(()=>{},1000)"] }), { registry: hang, killGraceMs: 200, registryTimeoutMs: 400 })).rejects.toThrow(ChildError);
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it("a_fast_child_with_a_slow_register_never_leaves_a_stale_row", async () => {
    const real = createChildRegistry(db.pool, "w-slow");
    const order: string[] = [];
    const slow = {
      register: async (r: Parameters<typeof real.register>[0]) => {
        await new Promise((res) => setTimeout(res, 400));
        await real.register(r);
        order.push("register");
      },
      unregister: async (pid: number, s: number) => {
        order.push("unregister");
        await real.unregister(pid, s);
      },
    };
    const r = await runChild(spec({ args: ["-e", "setTimeout(()=>{},150)"] }), { registry: slow, killGraceMs: 200 });
    expect(r.code).toBe(0);
    expect(order).toEqual(["register", "unregister"]);
    expect(await rows()).toHaveLength(0);
  });

  it("cwdRoot_is_enforced_by_runChild", async () => {
    await expect(runChild(spec({ args: ["-e", "0"], cwdRoot: path.join(tmp, "nowhere-else") }), deps())).rejects.toThrow(ChildError);
  });

  it("abort_kills_the_whole_process_group_including_grandchildren", async () => {
    const pidFile = path.join(tmp, "grandchild.pid");
    const code = `const {spawn}=require('child_process');const g=spawn('sleep',['300'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setTimeout(()=>{},60000)`;
    const ac = new AbortController();
    const p = runChild(spec({ args: ["-e", code], signal: ac.signal }), deps());
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, "utf8")).length > 0;
      } catch {
        return false;
      }
    });
    const gpid = Number(await readFile(pidFile, "utf8"));
    expect(alive(gpid)).toBe(true);
    const t0 = Date.now();
    ac.abort();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    await waitFor(() => !alive(gpid), 5000);
  });

  it("sigterm_ignoring_child_is_sigkilled_after_the_grace", async () => {
    const ac = new AbortController();
    const p = runChild(spec({ args: ["-e", "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)"], signal: ac.signal, onLine: () => ac.abort() }), deps());
    const r = await p;
    expect(r.signal).toBe("SIGKILL");
  });

  it("an_already_aborted_signal_never_spawns", async () => {
    const ac = new AbortController();
    ac.abort();
    const marker = path.join(tmp, "should-not-exist");
    const r = await runChild(spec({ args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`], signal: ac.signal }), deps());
    expect(r.aborted).toBe(true);
    await expect(stat(marker)).rejects.toThrow();
  });

  it("timeout_kills_and_reports", async () => {
    const t0 = Date.now();
    const r = await runChild(spec({ args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 300 }), deps());
    expect(r.timedOut).toBe(true);
    expect(r.signal).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await rows()).toHaveLength(0);
  });

  it("output_over_the_cap_is_truncated_and_child_killed", async () => {
    let bytes = 0;
    const r = await runChild(
      spec({ args: ["-e", "setInterval(()=>process.stdout.write('x'.repeat(4096)+'\\n'),1)"], maxOutputBytes: 10_000, onLine: (l) => (bytes += l.length) }),
      deps(),
    );
    expect(r.truncated).toBe(true);
    expect(r.signal).not.toBeNull();
    expect(bytes).toBeLessThanOrEqual(10_000);
  });

  it("a_single_endless_line_is_split_not_buffered_whole", async () => {
    const lens: number[] = [];
    await runChild(spec({ args: ["-e", "process.stdout.write('y'.repeat(300000))"], onLine: (l) => lens.push(l.length) }), deps());
    expect(Math.max(...lens)).toBeLessThanOrEqual(64 * 1024);
    expect(lens.reduce((a, b) => a + b, 0)).toBe(300000);
  });

  it("a_throwing_line_handler_does_not_break_the_run", async () => {
    const r = await runChild(spec({ args: ["-e", "console.log('a');console.log('b')"], onLine: () => { throw new Error("sink full"); } }), deps());
    expect(r.code).toBe(0);
  });

  it("command_with_shell_metacharacters_is_passed_literally", async () => {
    const marker = path.join(tmp, "pwned");
    const nasty = `a; touch ${marker} && echo $HOME \`id\` | cat > /dev/null`;
    const lines: string[] = [];
    const r = await runChild(spec({ args: ["-e", "console.log(process.argv[1])", nasty], onLine: (l) => lines.push(l) }), deps());
    expect(r.code).toBe(0);
    expect(lines).toEqual([nasty]);
    await expect(stat(marker)).rejects.toThrow();
  });

  it("a_missing_binary_is_a_plain_error_not_a_crash", async () => {
    await expect(runChild(spec({ command: "definitely-not-a-binary-xyz", args: [] }), deps())).rejects.toThrow(ChildError);
    expect(await rows()).toHaveLength(0);
  });

  it("disk_full_fails_that_stage_not_the_worker", async () => {
    // macOS has no /dev/full and a tiny tmpfs needs root, so the child reports ENOSPC the way a full disk would.
    const lines: string[] = [];
    const r = await runChild(
      spec({ args: ["-e", "console.error('ENOSPC: no space left on device, write'); process.exit(1)"], onLine: (l) => lines.push(l) }),
      deps(),
    );
    expect(r.code).toBe(1);
    expect(lines.join()).toContain("ENOSPC");
    // the worker is fine: it can run another child right away
    expect((await runChild(spec({ args: ["-e", "0"] }), deps())).code).toBe(0);
  });

  it("registration_failure_kills_the_child_and_rejects", async () => {
    const pidFile = path.join(tmp, "reg-fail.pid");
    const failing = { register: async () => { await new Promise((r) => setTimeout(r, 1500)); throw new Error("db down"); }, unregister: async () => undefined };
    await expect(
      runChild(spec({ args: ["-e", `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`] }), { registry: failing, killGraceMs: 200 }),
    ).rejects.toThrow("db down");
    await waitFor(async () => {
      try {
        return !alive(Number(await readFile(pidFile, "utf8")));
      } catch {
        return false;
      }
    }, 5000);
  });
});

describe("orphan sweep", () => {
  let helper: ChildProcess | undefined;
  const orphanPids: number[] = [];
  afterAll(() => {
    helper?.kill("SIGKILL");
    for (const p of orphanPids) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } }
  });

  it("sigkilled_worker_leaves_orphan_and_boot_sweep_kills_it", async () => {
    const stageRunId = sid();
    helper = spawn(NODE, ["--import", "tsx", "tests/integration/helpers/orphan-worker.mts"], {
      env: { ...process.env, HELPER_DATABASE_URL: db.ownerUrl.replace("ytstudio_owner", "ytstudio_app").replace("test-owner-pw", "test-app-pw"), HELPER_STAGE_RUN_ID: stageRunId },
      stdio: "ignore",
    });
    await waitFor(async () => (await rows()).length === 1, 60_000);
    const pid = Number((await rows())[0].pid);
    orphanPids.push(pid);
    expect(alive(pid)).toBe(true);

    process.kill(helper.pid!, "SIGKILL"); // the "worker" dies without cleanup
    await new Promise((r) => helper!.once("exit", r));
    // npx/tsx wrappers may leave the real node helper running; find and kill nothing else: the row's child is what matters.
    expect(alive(pid)).toBe(true); // orphan survived
    expect(await rows()).toHaveLength(1);

    const killed = await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 });
    expect(killed).toBe(1);
    await waitFor(() => !alive(pid), 5000);
    expect(await rows()).toHaveLength(0);
  }, 90_000);

  async function insertRow(pid: number, started: number, label: string, args: string, worker = "dead") {
    await db.pool.query(
      "insert into child_processes (pid, started_at_epoch, command_label, args_sha256, worker_id, stage_run_id) values ($1,$2,$3,$4,$5,$6)",
      [pid, started, label, argsHash(args), worker, sid()],
    );
  }
  async function liveRow(startedAtEpoch: number | null, label = "sleep", worker = "dead", argsOverride?: string) {
    const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    c.unref();
    orphanPids.push(c.pid!);
    const info = await readProcInfo(c.pid!);
    expect(info).not.toBeNull();
    await insertRow(c.pid!, startedAtEpoch ?? info!.startedAtEpoch, label, argsOverride ?? info!.args, worker);
    return c.pid!;
  }

  it("sweep_leaves_a_live_other_workers_rows_alone_and_kills_them_once_it_is_dead", async () => {
    const lock = await holdWorkerLock(db.pool, "live-other");
    const pid = await liveRow(null, "sleep", "live-other");
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(0);
    expect(alive(pid)).toBe(true);
    expect(await rows()).toHaveLength(1); // not deleted either
    await expect(holdWorkerLock(db.pool, "live-other")).rejects.toThrow(/already running/);
    await lock.release();
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(1);
    await waitFor(() => !alive(pid), 5000);
    expect(await rows()).toHaveLength(0);
  });

  it("a_worker_whose_connection_died_is_treated_as_dead", async () => {
    const client = await db.pool.connect();
    await client.query("select pg_advisory_lock(hashtextextended('yt-child-worker:' || $1, 0))", ["crashed"]);
    const pid = await liveRow(null, "sleep", "crashed");
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(0); // still held
    client.release(true); // connection destroyed, as when a worker process dies
    await waitFor(async () => (await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })) === 1, 5000);
    await waitFor(() => !alive(pid), 5000);
  });

  it("sweep_kills_surviving_group_members_when_the_leader_is_already_dead", async () => {
    const pidFile = path.join(tmp, "member.pid");
    const code = `const {spawn}=require('child_process');const g=spawn('sleep',['300'],{stdio:'ignore'});g.unref();require('fs').writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000)`;
    const leader = spawn(NODE, ["-e", code], { detached: true, stdio: "ignore" });
    orphanPids.push(leader.pid!);
    await waitFor(async () => {
      try {
        return (await readFile(pidFile, "utf8")).length > 0;
      } catch {
        return false;
      }
    });
    const member = Number(await readFile(pidFile, "utf8"));
    orphanPids.push(member);
    const info = (await readProcInfo(leader.pid!))!;
    await insertRow(leader.pid!, info.startedAtEpoch, commandLabelOf(info.args), info.args);
    process.kill(leader.pid!, "SIGKILL"); // only the leader dies
    await new Promise((r) => leader.once("exit", r));
    expect(alive(leader.pid!)).toBe(false);
    expect(alive(member)).toBe(true);
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(1);
    await waitFor(() => !alive(member), 5000);
    expect(await rows()).toHaveLength(0);
  });

  it("sweep_matching_ignores_timezone_of_the_sweeping_process", async () => {
    const pid = await liveRow(null);
    const tz = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14: a local-time reading would be off by hours
      expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(1);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    await waitFor(() => !alive(pid), 5000);
  });

  it("proc_info_start_time_is_real_utc_and_the_same_under_any_TZ", async () => {
    const c = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    c.unref();
    orphanPids.push(c.pid!);
    const before = Math.floor(Date.now() / 1000);
    const tz = process.env.TZ;
    const seen: number[] = [];
    try {
      for (const z of ["UTC", "Asia/Kolkata", "America/New_York"]) {
        process.env.TZ = z;
        seen.push((await readProcInfo(c.pid!))!.startedAtEpoch);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
    expect(new Set(seen).size).toBe(1);
    expect(Math.abs(seen[0]! - before)).toBeLessThanOrEqual(5);
  });

  it("sweep_ignores_a_pid_whose_command_line_differs_even_with_the_same_name", async () => {
    const pid = await liveRow(null, "sleep", "dead", "sleep 12345");
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(0);
    expect(alive(pid)).toBe(true);
    expect(await rows()).toHaveLength(0);
  });

  it("sweep_kills_a_matching_live_process_and_its_group", async () => {
    const pid = await liveRow(null);
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(1);
    await waitFor(() => !alive(pid), 5000);
    expect(await rows()).toHaveLength(0);
  });

  it("sweep_ignores_a_reused_pid_with_a_different_start_time", async () => {
    const info0 = Math.floor(Date.now() / 1000) - 100_000;
    const pid = await liveRow(info0);
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(0);
    expect(alive(pid)).toBe(true); // innocent process untouched
    expect(await rows()).toHaveLength(0); // stale row still removed
  });

  it("sweep_ignores_a_reused_pid_running_a_different_command", async () => {
    const pid = await liveRow(null, "ffmpeg");
    expect(await sweepOrphans(db.pool, "w-new", { killGraceMs: 300 })).toBe(0);
    expect(alive(pid)).toBe(true);
  });

  it("sweep_removes_rows_of_dead_pids_without_error", async () => {
    await insertRow(999999, 1, "sleep", "sleep 300");
    expect(await sweepOrphans(db.pool, "w-new")).toBe(0);
    expect(await rows()).toHaveLength(0);
  });

  it("sweep_never_kills_its_own_process", async () => {
    const me = (await readProcInfo(process.pid))!;
    await insertRow(process.pid, me.startedAtEpoch, commandLabelOf(me.args), me.args);
    expect(await sweepOrphans(db.pool, "w-new")).toBe(0);
    expect(alive(process.pid)).toBe(true);
  });
});
