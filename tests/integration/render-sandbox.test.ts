import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { removeJobContainers, startRenderJob, type RenderJobSpec } from "@/server/render/runner";
import { assertDockerUp } from "../support/infra";

const run = promisify(execFile);
const IMAGE = "ytstudio-render:dev";

let storageRoot: string;
const started: string[] = [];
let n = 0;

const dockerOut = async (...args: string[]) => (await run("docker", args)).stdout.trim();
const newId = () => `sbx-${process.pid}-${Date.now()}-${n++}`;

function makeJob(): { jobId: string; jobDir: string } {
  const jobId = newId();
  started.push(jobId);
  const jobDir = path.join(storageRoot, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  chmodSync(jobDir, 0o777); // the container runs as uid 10001
  return { jobId, jobDir };
}

function spec(over: Partial<RenderJobSpec> & { command: string[] }): RenderJobSpec {
  const { jobId, jobDir } = makeJob();
  return { jobId, storageRoot, jobDir, ...over };
}

beforeAll(async () => {
  await assertDockerUp();
  await run("docker", ["image", "inspect", IMAGE]).catch(async () => {
    await run("docker", ["build", "-f", "infra/Dockerfile.render", "-t", IMAGE, "."]);
  });
  storageRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-sbx-")));
  chmodSync(storageRoot, 0o755);
}, 900_000);

afterEach(async () => {
  await Promise.all(started.splice(0).map((id) => removeJobContainers(id).catch(() => undefined)));
});

afterAll(() => {
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

describe("render sandbox", () => {
  it("inspect_shows_every_flag", async () => {
    const job = await startRenderJob(spec({ command: ["node", "-e", "setTimeout(()=>{},30000)"] }));
    const [info] = JSON.parse(await dockerOut("inspect", job.containerId));
    expect(info.HostConfig.NetworkMode).toBe("none");
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.Config.User).toBe("10001:10001");
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(info.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(info.HostConfig.Memory).toBeGreaterThan(0);
    expect(info.HostConfig.PidsLimit).toBeGreaterThan(0);
    expect(info.HostConfig.NanoCpus).toBeGreaterThan(0);
    expect(info.HostConfig.ShmSize).toBe(256 * 1024 * 1024);
    expect(info.HostConfig.Privileged).toBe(false);
    const env: string[] = info.Config.Env;
    for (const e of env) {
      expect(e).not.toMatch(/^(DATABASE_URL|REDIS_URL)=/);
      expect(e).not.toMatch(/(_KEY|_TOKEN|_SECRET)=/);
    }
    expect(info.Config.Labels["ytstudio.job"]).toMatch(/^sbx-/);
    await job.kill();
  });

  it("no_network_even_to_loopback_services", async () => {
    const job = await startRenderJob(
      spec({
        command: [
          "node",
          "-e",
          `const fs=require('fs');const cp=require('child_process');
           const ifs=fs.readdirSync('/sys/class/net');
           if(ifs.some(i=>i!=='lo')){console.error('iface '+ifs);process.exit(2)}
           const g=cp.spawnSync('getent',['hosts','example.com']);
           if(g.status===0){console.error('dns resolved');process.exit(3)}
           fetch('http://example.com').then(()=>process.exit(0),()=>process.exit(7));`,
        ],
      }),
    );
    const r = await job.wait();
    expect(r.exitCode, r.logs).toBe(7);
  });

  it("root_filesystem_is_read_only", async () => {
    const { jobId, jobDir } = makeJob();
    const outside = path.join(storageRoot, "secret.txt");
    writeFileSync(outside, "top secret");
    chmodSync(outside, 0o666);
    const job = await startRenderJob({
      jobId,
      storageRoot,
      jobDir,
      command: [
        "node",
        "-e",
        `const fs=require('fs');
         const tryW=(p)=>{try{fs.writeFileSync(p,'x');return true}catch{return false}};
         const res={etc:tryW('/etc/x'),job:tryW(${JSON.stringify(path.join(jobDir, "out.txt"))}),tmp:tryW('/tmp/x'),
           outside:tryW(${JSON.stringify(outside)}),outsideVisible:fs.existsSync(${JSON.stringify(outside)})};
         console.log(JSON.stringify(res));`,
      ],
    });
    const r = await job.wait();
    expect(r.exitCode, r.logs).toBe(0);
    expect(JSON.parse(r.logs.trim())).toEqual({ etc: false, job: true, tmp: true, outside: false, outsideVisible: false });
    expect(readFileSync(path.join(jobDir, "out.txt"), "utf8")).toBe("x");
    expect(readFileSync(outside, "utf8")).toBe("top secret");
  });

  it("assets_dir_is_mounted_read_only_when_present", async () => {
    const assets = path.join(storageRoot, "assets");
    mkdirSync(assets, { recursive: true });
    chmodSync(assets, 0o777);
    const f = path.join(assets, "a.txt");
    writeFileSync(f, "asset");
    chmodSync(f, 0o666);
    const job = await startRenderJob(
      spec({
        command: [
          "node",
          "-e",
          `const fs=require('fs');let w=true;try{fs.writeFileSync(${JSON.stringify(f)},'y')}catch{w=false}
           console.log(fs.readFileSync(${JSON.stringify(f)},'utf8')+':'+w)`,
        ],
      }),
    );
    const r = await job.wait();
    expect(r.logs.trim()).toBe("asset:false");
    rmSync(assets, { recursive: true, force: true });
  });

  it("host_secrets_are_invisible", async () => {
    const job = await startRenderJob(
      spec({
        command: [
          "node",
          "-e",
          `const fs=require('fs');
           const ls=(d)=>{try{return fs.readdirSync(d).length}catch{return -1}};
           const bad=Object.keys(process.env).filter(k=>/DATABASE_URL|REDIS_URL|_KEY$|_TOKEN$|_SECRET$|^USER$|^SSH_/.test(k));
           console.log(JSON.stringify({users:ls('/Users'),root:ls('/root'),bad,keys:Object.keys(process.env).sort()}));`,
        ],
      }),
    );
    const r = await job.wait();
    const out = JSON.parse(r.logs.trim());
    expect(out.users <= 0).toBe(true);
    expect(out.root <= 0).toBe(true);
    expect(out.bad).toEqual([]);
  });

  it("kill_stops_a_hung_render_fast", async () => {
    const { jobId, jobDir } = makeJob();
    const job = await startRenderJob({
      jobId,
      storageRoot,
      jobDir,
      command: ["node", "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1e6)"],
    });
    const t0 = Date.now();
    await job.kill();
    expect(Date.now() - t0).toBeLessThan(5000);
    await job.kill(); // idempotent
    expect(await dockerOut("ps", "-aq", "--filter", `label=ytstudio.job=${jobId}`)).toBe("");
    const r = await job.wait();
    expect(r.exitCode).not.toBe(0);
  });

  it("wait_returns_exit_code_and_logs", async () => {
    const job = await startRenderJob(spec({ command: ["node", "-e", "console.log('out-line');console.error('boom');process.exit(3)"] }));
    const r = await job.wait();
    expect(r.exitCode).toBe(3);
    expect(r.logs).toContain("boom");
    expect(r.logs).toContain("out-line");
    expect(await dockerOut("ps", "-aq", "--filter", `label=${"ytstudio.job"}`).then((s) => s.includes(job.containerId.slice(0, 12)))).toBe(false);
  });

  it("wait_caps_logs_and_keeps_the_tail", async () => {
    const job = await startRenderJob(
      spec({ command: ["node", "-e", "process.stdout.write('a'.repeat(2*1024*1024));process.stdout.write('TAIL-MARK')"] }),
    );
    const r = await job.wait();
    expect(r.logs.length).toBeLessThanOrEqual(1024 * 1024);
    expect(r.logs.endsWith("TAIL-MARK")).toBe(true);
  });

  it("tmpfs_option_hides_a_container_path", async () => {
    const job = await startRenderJob(
      spec({
        tmpfs: ["/usr/share/fonts"],
        command: ["node", "-e", "console.log(require('fs').readdirSync('/usr/share/fonts').length)"],
      }),
    );
    const r = await job.wait();
    expect(r.logs.trim()).toBe("0");
  });

  it("removeJobContainers_removes_unwaited_containers", async () => {
    const { jobId, jobDir } = makeJob();
    await startRenderJob({ jobId, storageRoot, jobDir, command: ["node", "-e", "setTimeout(()=>{},60000)"] });
    expect(await dockerOut("ps", "-aq", "--filter", `label=ytstudio.job=${jobId}`)).not.toBe("");
    await removeJobContainers(jobId);
    expect(await dockerOut("ps", "-aq", "--filter", `label=ytstudio.job=${jobId}`)).toBe("");
    await removeJobContainers(jobId); // nothing left: still fine
  });
});

describe("render sandbox input validation", () => {
  const base = () => {
    const { jobId, jobDir } = makeJob();
    return { jobId, storageRoot, jobDir, command: ["true"] };
  };

  it.each(["", "-v/:/host", "a b", "a:b", "../x", ".hidden", "x".repeat(65), "a,b", "a/b"])("rejects jobId %j", async (jobId) => {
    await expect(startRenderJob({ ...base(), jobId })).rejects.toThrow(/jobId/);
    await expect(removeJobContainers(jobId)).rejects.toThrow(/jobId/);
  });

  it("rejects relative, non-normalised, root, colon and comma paths", async () => {
    const b = base();
    const bad = ["relative/dir", `${storageRoot}/jobs/../jobs/x`, `${b.jobDir}/`, "/", `${storageRoot}/a:ro`, `${storageRoot}/a,b`];
    for (const jobDir of bad) {
      await expect(startRenderJob({ ...b, jobDir }), jobDir).rejects.toThrow();
    }
    await expect(startRenderJob({ ...b, storageRoot: "rel" })).rejects.toThrow();
  });

  it("rejects a jobDir outside storageRoot, equal to it, or a sibling prefix", async () => {
    const b = base();
    const sibling = `${storageRoot}-evil`;
    mkdirSync(sibling, { recursive: true });
    try {
      await expect(startRenderJob({ ...b, jobDir: sibling })).rejects.toThrow(/inside/);
      await expect(startRenderJob({ ...b, jobDir: storageRoot })).rejects.toThrow(/inside/);
      await expect(startRenderJob({ ...b, jobDir: tmpdir() })).rejects.toThrow();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("rejects symlinked and nonexistent paths", async () => {
    const b = base();
    const link = path.join(storageRoot, "jobs", "link");
    symlinkSync("/etc", link);
    await expect(startRenderJob({ ...b, jobDir: link })).rejects.toThrow(/symlink|real/);
    await expect(startRenderJob({ ...b, jobDir: path.join(storageRoot, "jobs", "nope") })).rejects.toThrow();
    expect(existsSync(link)).toBe(true);
  });

  it("rejects bad tmpfs, image, limits and empty command", async () => {
    const b = base();
    for (const t of ["relative", "/a:b", "/a,b", "/"]) {
      await expect(startRenderJob({ ...b, tmpfs: [t] }), t).rejects.toThrow(/tmpfs/);
    }
    await expect(startRenderJob({ ...b, image: "--privileged" })).rejects.toThrow(/image/);
    await expect(startRenderJob({ ...b, limits: { cpus: 0, memoryMb: 1, pids: 1 } })).rejects.toThrow(/limits/);
    await expect(startRenderJob({ ...b, command: [] })).rejects.toThrow(/command/);
  });

  it("no containers were created by rejected specs", async () => {
    expect(await dockerOut("ps", "-aq", "--filter", `label=ytstudio.job=${base().jobId}`)).toBe("");
  });
});

describe("render sandbox round-1 fixes", () => {
  const labelled = (id: string) => dockerOut("ps", "-aq", "--filter", `label=ytstudio.job=${id}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("start_failure_leaves_no_container", async () => {
    const { jobId, jobDir } = makeJob();
    // create succeeds, start fails (tmpfs over a file): docker leaves a Created container
    await expect(startRenderJob({ jobId, storageRoot, jobDir, command: ["node", "-e", "1"], tmpfs: ["/usr/local/bin/node"] })).rejects.toThrow();
    expect(await labelled(jobId)).toBe("");
  });

  it("abort_during_start_removes_container", async () => {
    const { jobId, jobDir } = makeJob();
    const ac = new AbortController();
    const p = startRenderJob({ jobId, storageRoot, jobDir, command: ["node", "-e", "setTimeout(()=>{},60000)"], signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await p.catch(() => undefined);
    await sleep(2500);
    expect(await labelled(jobId)).toBe("");
    const pre = new AbortController();
    pre.abort();
    await expect(startRenderJob({ jobId, storageRoot, jobDir, command: ["true"], signal: pre.signal })).rejects.toThrow();
    await sleep(1500);
    expect(await labelled(jobId)).toBe("");
  });

  it.each(["/proc", "/sys", "/dev", "/proc/sys", "/dev/shm", "/sys/fs", "/tmp"])("tmpfs_proc_sys_dev_rejected %s", async (t) => {
    const { jobId, jobDir } = makeJob();
    await expect(startRenderJob({ jobId, storageRoot, jobDir, command: ["true"], tmpfs: [t] })).rejects.toThrow(/tmpfs/);
    expect(await labelled(jobId)).toBe("");
  });

  it("jobdir_inside_assets_rejected", async () => {
    const { jobId } = makeJob();
    const jobDir = path.join(storageRoot, "assets", "evil");
    mkdirSync(jobDir, { recursive: true });
    await expect(startRenderJob({ jobId, storageRoot, jobDir, command: ["true"] })).rejects.toThrow(/assets/);
    rmSync(path.join(storageRoot, "assets"), { recursive: true, force: true });
  });

  it("jobdir_is_assets_rejected", async () => {
    const { jobId } = makeJob();
    const jobDir = path.join(storageRoot, "assets");
    mkdirSync(jobDir, { recursive: true });
    await expect(startRenderJob({ jobId, storageRoot, jobDir, command: ["true"] })).rejects.toThrow();
    rmSync(jobDir, { recursive: true, force: true });
  });

  it("jobdir_ancestor_of_assets_rejected", async () => {
    const { jobId } = makeJob();
    await expect(startRenderJob({ jobId, storageRoot, jobDir: storageRoot, command: ["true"] })).rejects.toThrow();
  });

  it("jobdir_top_level_dir_rejected", async () => {
    const { jobId } = makeJob();
    await expect(startRenderJob({ jobId, storageRoot, jobDir: path.join(storageRoot, "jobs"), command: ["true"] })).rejects.toThrow(/two/);
  });

  it("jobdir_two_levels_below_root_accepted", async () => {
    const { jobId } = makeJob();
    const jobDir = path.join(storageRoot, "videos", "v1", "attempt-3");
    mkdirSync(jobDir, { recursive: true });
    chmodSync(jobDir, 0o777);
    const r = await (await startRenderJob({ jobId, storageRoot, jobDir, command: ["true"] })).wait();
    expect(r.exitCode).toBe(0);
  });

  it("logs_are_size_capped_by_the_daemon", async () => {
    const job = await startRenderJob(
      spec({
        command: [
          "node",
          "-e",
          "const c='x'.repeat(1024*1024);for(let i=0;i<50;i++)process.stdout.write(c);process.stdout.write('TAIL-MARK')",
        ],
      }),
    );
    const [info] = JSON.parse(await dockerOut("inspect", job.containerId));
    expect(info.HostConfig.LogConfig.Type).toBe("local");
    expect(info.HostConfig.LogConfig.Config["max-size"]).toBe("10m");
    expect(info.HostConfig.LogConfig.Config["max-file"]).toBe("2");
    const r = await job.wait();
    expect(r.logs.length).toBeLessThanOrEqual(1024 * 1024);
    expect(r.logs.endsWith("TAIL-MARK")).toBe(true);
  }, 60_000);
});
