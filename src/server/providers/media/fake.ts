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
  const price = opts.priceMicroUsd ?? 4000;
  return {
    capability: { id: "fake-image", refImages: true, seed: true, aspects: ["9:16", "16:9", "1:1"], maxRefs: 3 },
    quote: () => price,
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async generate(ctx: StageContext, a) {
      const played = await s.play(`fake:image:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: price });
      const sha256 = createHash("sha256").update(`${a.aspect}\0${a.prompt}`).digest("hex");
      const imagePath = path.join(ctx.attemptDir, `image-${sha256.slice(0, 12)}.png`);
      await writeFile(imagePath, PNG);
      return { path: imagePath, bytes: PNG.length, sha256, provenance: { provider: "fake-image", model: a.model, params: { aspect: a.aspect }, priceMicroUsd: played.actualMicroUsd, quoted: true } };
    },
  };
}
