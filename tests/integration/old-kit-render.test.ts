import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEngineConfig } from "@/server/core/engine-config";
import type { StageContext } from "@/server/core/stage-handler";
import { renderTsx, renderTsxStills, type TsxRendererDeps } from "@/server/providers/renderer/tsx-render";
import { probeVideo } from "@/server/render/probe";
import { RENDER_IMAGE } from "@/server/render/runner";
import { runChild } from "@/server/render/child";
import { renderKitDir } from "@/worker/handlers";
import { assertDockerUp } from "../support/infra";
import { assertFfprobeAvailable } from "../support/tools";

// old-kit-import acceptance: two of the old app's best shorts (13 binary search, 14 Docker), converted only in their imports
// (tests/fixtures/old-shorts), pass the code-scene checks and render in the locked container through the engine's paths,
// using the imported yt-old libraries.

const run = promisify(execFile);
let root: string;
beforeAll(async () => {
  assertFfprobeAvailable();
  await assertDockerUp();
  await run("docker", ["image", "inspect", RENDER_IMAGE]).catch(async () => {
    await run("docker", ["build", "-f", "infra/Dockerfile.render", "-t", RENDER_IMAGE, "."], { timeout: 1_500_000, maxBuffer: 64 << 20 });
  });
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "old-kit-render-")));
}, 1_600_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const deps: TsxRendererDeps = { kitDir: renderKitDir(), runChild: (spec) => runChild(spec), probe: (file, signal) => probeVideo(file, signal, { storageRoot: root }) };
const ctx = (name: string): StageContext => {
  const attemptDir = path.join(root, name);
  rmSync(attemptDir, { recursive: true, force: true });
  return { stage: { name: "tsx_author", videoId: "v" }, claim: { stageRunId: `old-kit-${name}`, fence: 1, workerId: "t" }, config: buildEngineConfig(new Map()), signal: new AbortController().signal, attemptDir, log: () => undefined } as unknown as StageContext;
};
const source = (n: string) => readFileSync(`tests/fixtures/old-shorts/${n}.tsx`, "utf8");
const size = (file: string) => {
  const png = PNG.sync.read(readFileSync(file));
  return [png.width, png.height];
};

describe("old shorts through the engine renderer", () => {
  it.each([["short-13", [0, 600, 1229]], ["short-14", [0, 600, 1259]]] as const)("%s passes the checks and draws preview frames", async (name, frames) => {
    const c = ctx(name);
    await import("node:fs").then((fs) => fs.mkdirSync(c.attemptDir, { recursive: true }));
    const r = await renderTsxStills(deps, c, { source: source(name), frames });
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    expect(r.files).toHaveLength(3);
    for (const f of r.files) expect(size(f)).toEqual([1080, 1920]);
  }, 600_000);

  it("a_code_scene_using_yt_om_HeroTitle_renders", async () => {
    // the bespoke path: a code scene drawing with OpenMontage's own HeroTitle and BarChart (yt-om), in the locked renderer
    const c = ctx("yt-om");
    await import("node:fs").then((fs) => fs.mkdirSync(c.attemptDir, { recursive: true }));
    const src = `import { AbsoluteFill, Sequence } from "remotion";
import { HeroTitle } from "yt-om/HeroTitle";
import { BarChart } from "yt-om/BarChart";
export default function Scene() {
  return (
    <AbsoluteFill style={{ backgroundColor: "#0B1020" }}>
      <Sequence durationInFrames={60}><HeroTitle title="Bespoke" subtitle="with OpenMontage parts" accentColor="#FF0000" /></Sequence>
      <Sequence from={60} durationInFrames={60}><BarChart data={[{ label: "A", value: 3 }, { label: "B", value: 5 }]} colors={["#FF0000"]} /></Sequence>
    </AbsoluteFill>
  );
}
export const meta = { durationInFrames: 120, fps: 30, width: 1080, height: 1920 };
`;
    const r = await renderTsxStills(deps, c, { source: src, frames: [45, 90] }); // not the last 15 frames: OpenMontage's charts fade out there
    if (!r.ok) throw new Error(`${r.message} ${r.problems.join(" | ")}`);
    for (const f of r.files) {
      const png = PNG.sync.read(readFileSync(f));
      let red = 0;
      for (let i = 0; i < png.data.length; i += 4) if (png.data[i]! > 200 && png.data[i + 1]! < 60 && png.data[i + 2]! < 60) red++;
      expect(red, f).toBeGreaterThan(500); // the accent letters, then the bars, are drawn
    }
  }, 600_000);

  it("preflight_only_checks_the_frames_like_a_render_and_makes_no_video", async () => {
    // the engine's check_frames: the same first/middle/last check the final render applies, without rendering the video
    const c = ctx("preflight-only");
    await import("node:fs").then((fs) => fs.mkdirSync(c.attemptDir, { recursive: true }));
    const empty0 = `import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export default function Scene() {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ backgroundColor: "#0B1020" }}><div style={{ position: "absolute", left: 140, top: 700, width: 800, height: 500, borderRadius: 40, background: "#7C3AED", opacity: interpolate(f, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} /></AbsoluteFill>;
}
export const meta = { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
`;
    const bad = await renderTsx(deps, c, { source: empty0, outFile: "x.mp4", preflightOnly: true });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.problems.join(" ")).toMatch(/[Ff]rame 0 (is blank|: objects zone looks empty)/);
    const good = await renderTsx(deps, c, { source: source("short-13"), outFile: "x.mp4", preflightOnly: true });
    if (!good.ok) throw new Error(`${good.error.message} ${good.error.problems.join(" | ")}`);
    expect(good.outPath).toBe("");
    expect(existsSync(path.join(c.attemptDir, "x.mp4"))).toBe(false);
  }, 600_000);

  it("short-13 renders as a full video of its length", async () => {
    const c = ctx("short-13-full");
    await import("node:fs").then((fs) => fs.mkdirSync(c.attemptDir, { recursive: true }));
    const r = await renderTsx(deps, c, { source: source("short-13"), outFile: "render.mp4" });
    if (!r.ok) throw new Error(`${r.error.message} ${r.error.problems.join(" | ")}`);
    const p = await probeVideo(r.outPath, new AbortController().signal, { storageRoot: root });
    expect([p.width, p.height]).toEqual([1080, 1920]);
    expect(Math.abs(p.durationS - 41)).toBeLessThan(1);
  }, 1_200_000);
});
