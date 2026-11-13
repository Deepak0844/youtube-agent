import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
