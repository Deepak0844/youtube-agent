import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { ImageProvider } from "./index";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export function createFakeImage(opts: FakeOptions & { priceMicroUsd?: number } = {}): ImageProvider & FakeCounters {
  const s = createScript(opts);
  return {
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async generate(ctx: StageContext, a) {
      const played = await s.play(`fake:image:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: opts.priceMicroUsd ?? 4000 });
      const name = `image-${createHash("sha256").update(`${a.size.width}x${a.size.height}\0${a.prompt}`).digest("hex").slice(0, 12)}.png`;
      const imagePath = path.join(ctx.attemptDir, name);
      await writeFile(imagePath, PNG);
      return { imagePath, priceMicroUsd: played.actualMicroUsd };
    },
  };
}
