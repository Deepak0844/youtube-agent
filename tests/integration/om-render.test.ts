import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { renderOm } from "@/server/providers/renderer/om-render";
import type { TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { RENDER_IMAGE } from "@/server/render/runner";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";
import { assertDockerUp } from "../support/infra";
import { assertFfprobeAvailable } from "../support/tools";

// OpenMontage parity, Phase A: OpenMontage's own demo scene list (animated-reel-20s) draws through its Explainer composition
// (remotion/kit/om) in the locked render container, landscape and portrait. Side-by-side frames against OpenMontage's own
// render: scripts/om-compare.ts.

const run = promisify(execFile);
let root: string;
beforeAll(async () => {
  assertFfprobeAvailable();
  await assertDockerUp();
  await run("docker", ["image", "inspect", RENDER_IMAGE]).catch(async () => {
    await run("docker", ["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."], { timeout: 1_500_000, maxBuffer: 64 << 20 });
  });
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "om-render-")));
}, 1_600_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
const ctx = (name: string): StageContext => {
  const attemptDir = path.join(root, name);
  rmSync(attemptDir, { recursive: true, force: true });
  mkdirSync(attemptDir, { recursive: true });
  return { stage: { name: "om", videoId: "v" }, claim: { stageRunId: `om-${name}`, fence: 1, workerId: "t" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir, log: () => undefined } as unknown as StageContext;
};
const reel = JSON.parse(readFileSync("tests/fixtures/openmontage/animated-reel-20s.json", "utf8")) as Record<string, unknown>;
const png = (file: string) => PNG.sync.read(readFileSync(file));

describe("OpenMontage scene lists through the locked renderer", () => {
  it("draws chosen frames, landscape", async () => {
    const c = ctx("stills");
    const r = await renderOm(deps, c, { props: reel, orientation: "landscape", outFile: "x.mp4", stills: [0, 157, 629] });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    expect(r.stills).toEqual(["om-frame-0.png", "om-frame-157.png", "om-frame-629.png"]);
    for (const n of r.stills) {
      const p = png(path.join(c.attemptDir, n));
      expect([p.width, p.height]).toEqual([1920, 1080]);
    }
  }, 600_000);

  it("renders the whole reel as a portrait video of its length", async () => {
    const c = ctx("portrait");
    const r = await renderOm(deps, c, { props: reel, orientation: "portrait", outFile: "reel.mp4" });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(Math.abs(p.durationS - 21)).toBeLessThan(0.5);
  }, 600_000);

  it("lays a KPI grid out inside a portrait frame", async () => {
    // OpenMontage's KPIGrid placed its cards for 1920x1080; in a 1080-wide short the third card ran off the right edge
    const c = ctx("kpi-portrait");
    const props = { theme: "flat-motion-graphics", cuts: [{ id: "k", type: "kpi_grid", in_seconds: 0, out_seconds: 3, title: "Same everywhere", columns: 3, cardBackgroundColor: "#FF0000", chartData: [{ label: "Laptop", value: 1 }, { label: "CI", value: 2 }, { label: "Prod", value: 3 }] }] };
    const r = await renderOm(deps, c, { props, orientation: "portrait", outFile: "x.mp4", stills: [60] });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    const p = png(path.join(c.attemptDir, r.stills[0]!));
    const red = (x0: number, x1: number) => {
      let n = 0;
      for (let y = 0; y < p.height; y++) for (let x = x0; x < x1; x++) {
        const i = (y * p.width + x) * 4;
        if (p.data[i]! > 200 && p.data[i + 1]! < 60 && p.data[i + 2]! < 60) n++;
      }
      return n;
    };
    expect(red(0, 1000)).toBeGreaterThan(10_000); // the cards are drawn
    expect(red(1040, 1080)).toBe(0); // and none reaches the right margin
  }, 600_000);

  it("draws charts full width in a portrait frame", async () => {
    // OpenMontage's charts draw on a fixed 1920x1080 canvas, so a short showed them at 56% size; portrait now uses a 1080x1350 canvas
    const c = ctx("charts-portrait");
    const red = ["#FF0000"];
    const props = { theme: "flat-motion-graphics", cuts: [
      { id: "b", type: "bar_chart", in_seconds: 0, out_seconds: 3, chartColors: red, chartData: [{ label: "A", value: 5 }, { label: "B", value: 9 }] },
      { id: "p", type: "pie_chart", in_seconds: 3, out_seconds: 6, chartColors: ["#FF0000", "#0000FF"], chartData: [{ label: "Half", value: 1 }, { label: "Other", value: 1 }] },
    ] };
    const r = await renderOm(deps, c, { props, orientation: "portrait", outFile: "x.mp4", stills: [75, 165] });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    const box = (file: string) => {
      const p = png(path.join(c.attemptDir, file));
      let [x0, y0, x1, y1] = [p.width, p.height, -1, -1];
      for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        if (p.data[i]! > 200 && p.data[i + 1]! < 60 && p.data[i + 2]! < 60) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
      }
      return { w: x1 - x0, h: y1 - y0, right: x1 };
    };
    expect(box(r.stills[0]!).h).toBeGreaterThan(800); // the tallest bar (was about 430 px)
    const pie = box(r.stills[1]!);
    expect(pie.w).toBeGreaterThan(250); // a red half disc, 300 px across (was about 170)
    expect(pie.right).toBeLessThan(1080);
  }, 600_000);

  it("refuses a remote asset inside the box", async () => {
    const c = ctx("remote");
    const props = { ...reel, cuts: [{ id: "a", source: "https://example.com/a.png", in_seconds: 0, out_seconds: 1 }] };
    const r = await renderOm(deps, c, { props, orientation: "landscape", outFile: "x.mp4", stills: [0] });
    expect(r.ok).toBe(false);
  }, 600_000);
});
