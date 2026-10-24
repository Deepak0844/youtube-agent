import { execFile } from "node:child_process";
import { assertFfprobeAvailable } from "../support/tools";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { JOB_LABEL, RENDER_IMAGE, removeJobContainers, startRenderJob } from "@/server/render/runner";
import { assertDockerUp } from "../support/infra";

// Spike measurement: three published shorts from the old (read-only) project render inside the locked
// sandbox. Needs the old repo next to this one; CI has none, so it skips. SKIP_OLD_SHORTS=1 skips it too.
const run = promisify(execFile);
const OLD = path.resolve("../claude-faceless-shorts-creator");
const SCRIPT = path.resolve("scripts/spike/render-old-shorts.mjs");
const RESULTS = path.resolve("test-results");
// chess (visual-heavy, SVG piece assets), map (geo paths), longest + heaviest assets (9 JPEG stills).
const SHORTS = ["Short1Chess", "Short11Map", "Short7Kids"] as const;

const skipReason = process.env.SKIP_OLD_SHORTS === "1" ? "SKIP_OLD_SHORTS=1" : !existsSync(OLD) ? `old repo not found at ${OLD}` : null;
if (skipReason) console.warn(`old-shorts: skipped (${skipReason})`);

interface ManifestEntry {
  id: string;
  durationInSeconds: number;
  fps: number;
  width: number;
  height: number;
}
interface ShortMeasure {
  name: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  wallMs: number;
  renderMs: number;
  peakRssMb: number;
  cpuSeconds: number;
  findings: string[];
}
interface JobOut {
  bundleMs: number;
  browserMs: number;
  findings: string[];
  shorts: ShortMeasure[];
}

let storageRoot: string | undefined;
const jobIds: string[] = [];

afterAll(async () => {
  await Promise.all(jobIds.map((id) => removeJobContainers(id).catch(() => undefined)));
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
});

async function runJob(name: string, ids: readonly string[]): Promise<{ jobDir: string; out: JobOut; hostWallMs: number }> {
  const root = storageRoot!;
  const jobId = `old-${name}-${process.pid}-${Date.now()}`;
  jobIds.push(jobId);
  const jobDir = path.join(root, "jobs", jobId);
  mkdirSync(jobDir, { recursive: true });
  // A COPY of the old kit (never the original); its 919 MB node_modules is not copied.
  cpSync(path.join(OLD, "remotion", "src"), path.join(jobDir, "src"), {
    recursive: true,
    filter: (src) => path.basename(src) !== "registry.gen.tsx" && path.basename(src) !== "shots.manifest.json",
  });
  cpSync(path.join(OLD, "remotion", "scripts", "gen-registry.mjs"), path.join(jobDir, "scripts", "gen-registry.mjs"));
  cpSync(SCRIPT, path.join(jobDir, "render-old-shorts.mjs"));
  await run("chmod", ["-R", "a+rwX", jobDir]); // the container runs as uid 10001
  const t0 = performance.now();
  const job = await startRenderJob({
    jobId,
    storageRoot: root,
    jobDir,
    command: [
      "sh",
      "-c",
      'ls /sys/class/net > "$1/net.txt" && node "$1/scripts/gen-registry.mjs" && node "$1/render-old-shorts.mjs" "$@"',
      "sh",
      jobDir,
      path.join(root, "assets", "media"),
      ...ids,
    ],
  });
  const { exitCode, logs } = await job.wait();
  const hostWallMs = Math.round(performance.now() - t0);
  writeFileSync(path.join(RESULTS, `old-shorts-${name}.log`), logs);
  expect(exitCode, logs.slice(-4000)).toBe(0);
  expect(readFileSync(path.join(jobDir, "net.txt"), "utf8").trim(), "job ran with only loopback").toBe("lo");
  const line = logs.trim().split("\n").reverse().find((l) => l.startsWith('{"result"'));
  expect(line, logs.slice(-4000)).toBeDefined();
  return { jobDir, out: JSON.parse(line!).result as JobOut, hostWallMs };
}

async function probe(file: string) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-count_frames",
    "-show_entries", "stream=codec_name,width,height,nb_read_frames",
    "-of", "json",
    file,
  ]);
  return JSON.parse(stdout).streams[0] as { codec_name: string; width: number; height: number; nb_read_frames: string };
}

describe.skipIf(skipReason !== null)("old shorts", () => {
  it(
    "three_old_shorts_render_in_the_sandbox",
    async () => {
      assertFfprobeAvailable();
      await assertDockerUp();
      await run("docker", ["image", "inspect", RENDER_IMAGE]);
      mkdirSync(RESULTS, { recursive: true });
      mkdirSync(path.join(RESULTS, "old-shorts"), { recursive: true });
      storageRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-old-")));
      // Read-only inputs: the old project's public dir (Config.setPublicDir('../media')) goes into <root>/assets.
      cpSync(path.join(OLD, "media"), path.join(storageRoot, "assets", "media"), { recursive: true });
      await run("chmod", ["-R", "a+rX", storageRoot]);

      const manifest: ManifestEntry[] = JSON.parse(readFileSync(path.join(OLD, "remotion", "src", "shots.manifest.json"), "utf8"));
      const entry = (id: string) => {
        const e = manifest.find((m) => m.id === id);
        if (!e) throw new Error(`${id} not in manifest`);
        return e;
      };

      // Cold: one container per short, as in production. Warm: one container, one browser, all three.
      const cold: { jobDir: string; out: JobOut; hostWallMs: number }[] = [];
      for (const id of SHORTS) cold.push(await runJob(`cold-${id.toLowerCase()}`, [id]));
      const warm = await runJob("warm", SHORTS);

      const shorts = [];
      for (const [i, id] of SHORTS.entries()) {
        const e = entry(id);
        const frames = Math.max(1, Math.round(e.durationInSeconds * e.fps));
        const c = cold[i]!;
        const m = c.out.shorts[0]!;
        const w = warm.out.shorts.find((s) => s.name === id)!;
        for (const [jobDir, label] of [[c.jobDir, "cold"], [warm.jobDir, "warm"]] as const) {
          const file = path.join(jobDir, "out", `${id}.mp4`);
          const s = await probe(file);
          expect(s, `${id} ${label}`).toMatchObject({ codec_name: "h264", width: e.width, height: e.height });
          expect(Number(s.nb_read_frames), `${id} ${label}`).toBe(frames);
          if (label === "cold") cpSync(file, path.join(RESULTS, "old-shorts", `${id}.mp4`));
        }
        expect(m.frames).toBe(frames);
        shorts.push({
          name: id,
          frames: m.frames,
          fps: e.fps,
          width: e.width,
          height: e.height,
          wallMs: m.wallMs,
          renderMs: m.renderMs,
          hostWallMs: c.hostWallMs,
          peakRssMb: m.peakRssMb,
          cpuSeconds: m.cpuSeconds,
          warmWallMs: w.renderMs,
          warmPeakRssMbCumulative: w.peakRssMb,
          warmCpuSeconds: w.cpuSeconds,
          findings: [...new Set([...c.out.findings, ...m.findings])],
        });
      }
      const report = {
        host: { cpus: cpus().length, memGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10 },
        sandbox: { cpus: 4, memoryMb: 4096, network: "none" },
        warmJob: { bundleMs: warm.out.bundleMs, browserMs: warm.out.browserMs, hostWallMs: warm.hostWallMs },
        shorts,
      };
      writeFileSync(path.join(RESULTS, "old-shorts.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report, null, 2));

      expect(report.host.cpus).toBeGreaterThan(0);
      expect(report.host.memGb).toBeGreaterThan(0);
      expect(shorts).toHaveLength(3);
      for (const s of shorts) {
        for (const k of ["frames", "fps", "width", "height", "wallMs", "peakRssMb", "cpuSeconds", "warmWallMs"] as const) {
          expect(s[k], `${s.name}.${k}`).toBeGreaterThan(0);
        }
        expect(Array.isArray(s.findings)).toBe(true);
      }

      await Promise.all(jobIds.map((id) => removeJobContainers(id)));
      const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=${JOB_LABEL}`]);
      expect(stdout.trim()).toBe("");
    },
    45 * 60_000,
  );
});
