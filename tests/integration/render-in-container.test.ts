import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { assertFfprobeAvailable } from "../support/tools";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RENDER_IMAGE, removeJobContainers, startRenderJob } from "@/server/render/runner";
import { assertDockerUp } from "../support/infra";
import { removeStorageRoot } from "../support/storage";

const run = promisify(execFile);
const FIXTURE = path.resolve("tests/fixtures/remotion-spike");
const RESULTS = path.resolve("test-results");

// Must match the fixture layout: six 260px bands starting at y=100, 300px apart.
const REGIONS = ["devanagari", "tamil", "telugu", "malayalam", "kannada", "brand"] as const;
const INDIC = REGIONS.slice(0, 5);
const band = (i: number) => ({ y0: 100 + i * 300, y1: 100 + i * 300 + 260 });

let storageRoot: string;
const jobIds: string[] = [];
let fixtureBefore: string;
let gitBefore: string;

interface JobResult {
  jobDir: string;
  exitCode: number;
  logs: string;
}
let normal: JobResult;
let control: JobResult;

function fixtureFingerprint(): string {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else h.update(`${path.relative(FIXTURE, p)}:${st.mtimeMs}:${st.size}:`).update(readFileSync(p));
    }
  };
  walk(FIXTURE);
  return h.digest("hex");
}

const gitStatus = async () => (await run("git", ["status", "--porcelain", "--", FIXTURE])).stdout;

async function renderJob(name: string, extraArgs: string[], tmpfs?: string[]): Promise<JobResult> {
  const jobId = `r5-${name}-${process.pid}-${Date.now()}`;
  jobIds.push(jobId);
  const jobDir = path.join(storageRoot, "jobs", jobId);
  mkdirSync(path.dirname(jobDir), { recursive: true });
  cpSync(FIXTURE, jobDir, { recursive: true, filter: (src) => path.basename(src) !== "registry.gen.tsx" });
  chmodSync(jobDir, 0o777); // the container runs as uid 10001
  const job = await startRenderJob({
    jobId,
    storageRoot,
    jobDir,
    tmpfs,
    command: [
      "sh",
      "-c",
      'ls /sys/class/net > "$1/net.txt" && fc-list : family > "$1/fc-list.txt" && node "$1/gen-registry.mjs" "$1" && node "$1/render.mjs" "$@"',
      "sh",
      jobDir,
      ...extraArgs,
    ],
  });
  const { exitCode, logs } = await job.wait();
  return { jobDir, exitCode, logs };
}

function lastJson(logs: string): { coldMs: number; warmMs: number; peakRssMb: number; peakRssSource: string } {
  const line = logs.trim().split("\n").pop() ?? "";
  return JSON.parse(line);
}

function inkPerRegion(file: string): number[] {
  const png = PNG.sync.read(readFileSync(file));
  return REGIONS.map((_, i) => {
    const { y0, y1 } = band(i);
    let ink = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < png.width; x++) {
        const o = (y * png.width + x) * 4;
        const lum = 0.299 * png.data[o]! + 0.587 * png.data[o + 1]! + 0.114 * png.data[o + 2]!;
        if (lum < 128) ink++;
      }
    }
    return ink;
  });
}

beforeAll(async () => {
  assertFfprobeAvailable();
  await assertDockerUp();
  await run("docker", ["image", "inspect", RENDER_IMAGE]).catch(async () => {
    await run("docker", ["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."]);
  });
  fixtureBefore = fixtureFingerprint();
  gitBefore = await gitStatus();
  storageRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "ytstudio-r5-")));
  chmodSync(storageRoot, 0o755);
  // Control hides the vendored fonts (and their fontconfig cache) so Indic text has no font to shape with.
  [normal, control] = await Promise.all([
    renderJob("normal", []),
    renderJob("control", ["--still-only"], ["/usr/share/fonts/truetype/vendored", "/var/cache/fontconfig"]),
  ]);
  mkdirSync(RESULTS, { recursive: true });
  for (const [r, name] of [
    [normal, "indic.png"],
    [control, "indic-control.png"],
  ] as const) {
    const still = path.join(r.jobDir, "out", "indic.png");
    if (existsSync(still)) cpSync(still, path.join(RESULTS, name));
  }
}, 900_000);

afterAll(async () => {
  await Promise.all(jobIds.map((id) => removeJobContainers(id).catch(() => undefined)));
  await removeStorageRoot(storageRoot);
});

describe("render in container", () => {
  it("jobs_exit_cleanly", () => {
    expect(normal.exitCode, normal.logs).toBe(0);
    expect(control.exitCode, control.logs).toBe(0);
  });

  it("registry_is_generated_inside_the_container", async () => {
    expect(existsSync(path.join(FIXTURE, "registry.gen.tsx"))).toBe(false);
    const gen = path.join(normal.jobDir, "registry.gen.tsx");
    expect(existsSync(gen)).toBe(true);
    expect(readFileSync(gen, "utf8")).toContain("./scenes/IndicCard");
    expect(fixtureFingerprint()).toBe(fixtureBefore);
    expect(await gitStatus()).toBe(gitBefore);
  });

  it("renders_h264_with_network_none", async () => {
    expect(readFileSync(path.join(normal.jobDir, "net.txt"), "utf8").trim()).toBe("lo");
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-count_frames",
      "-show_entries", "stream=codec_name,width,height,nb_read_frames",
      "-of", "json",
      path.join(normal.jobDir, "out", "indic.mp4"),
    ]);
    const [s] = JSON.parse(stdout).streams;
    expect(s).toMatchObject({ codec_name: "h264", width: 1080, height: 1920 });
    expect(Number(s.nb_read_frames)).toBe(60);
  });

  it("indic_scripts_use_the_vendored_fonts", () => {
    const fcNormal = readFileSync(path.join(normal.jobDir, "fc-list.txt"), "utf8");
    const fcControl = readFileSync(path.join(control.jobDir, "fc-list.txt"), "utf8");
    expect(fcNormal).toContain("Noto Sans Devanagari");
    expect(fcControl).not.toMatch(/Noto Sans (Devanagari|Tamil|Telugu|Malayalam|Kannada)/);

    const a = inkPerRegion(path.join(normal.jobDir, "out", "indic.png"));
    const b = inkPerRegion(path.join(control.jobDir, "out", "indic.png"));
    console.log("ink per region", Object.fromEntries(REGIONS.map((r, i) => [r, { normal: a[i], control: b[i] }])));
    for (const v of a) expect(v).toBeGreaterThan(500);
    // Not "higher": hollow tofu boxes often carry MORE ink than the real glyphs (measured), so assert difference.
    INDIC.forEach((r, i) => expect(a[i], r).not.toBe(b[i]));
    expect(a.filter((v, i) => v !== b[i]).length).toBeGreaterThanOrEqual(5);
  });

  it("warm_second_render_is_faster", () => {
    const m = lastJson(normal.logs);
    console.log("render timings", m);
    expect(m.coldMs).toBeGreaterThan(0);
    expect(m.warmMs).toBeGreaterThan(0);
    expect(m.warmMs).toBeLessThan(m.coldMs);
    expect(m.peakRssMb).toBeGreaterThan(0);
  });
});
