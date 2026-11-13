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

  it("refuses a remote asset inside the box", async () => {
    const c = ctx("remote");
    const props = { ...reel, cuts: [{ id: "a", source: "https://example.com/a.png", in_seconds: 0, out_seconds: 1 }] };
    const r = await renderOm(deps, c, { props, orientation: "landscape", outFile: "x.mp4", stills: [0] });
    expect(r.ok).toBe(false);
  }, 600_000);
});
