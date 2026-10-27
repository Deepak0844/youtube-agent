import { copyFile } from "node:fs/promises";
import path from "node:path";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { Renderer } from "./index";

// No Remotion until Phase 4: "rendering" copies a fixture mp4 into the attempt dir. Default fixture is good.mp4
// (resolved from the repo root, so run from there as npm scripts and vitest do).
export function createFakeRenderer(opts: FakeOptions & { fixture?: string } = {}): Renderer & FakeCounters {
  const s = createScript(opts);
  const fixture = opts.fixture ?? path.resolve(process.cwd(), "tests/fixtures/video/good.mp4");
  return {
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async render(ctx: StageContext, a) {
      if (a.outFile === "" || a.outFile !== path.basename(a.outFile) || a.outFile.startsWith(".")) {
        throw new Error("outFile must be a plain file name");
      }
      await s.play(`fake:render:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: 0 });
      const outPath = path.join(ctx.attemptDir, a.outFile);
      await copyFile(fixture, outPath);
      return { outPath };
    },
  };
}
