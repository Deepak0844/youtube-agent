import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import { scopesOf } from "../image";
import type { ImageProvider } from "./index";

// 1x1 transparent PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

// Same call shape as the real adapters: the adapter reserves (ctx.paid) itself. The quote is the dry-run price the plan uses; the
// scripted `priceMicroUsd` is what the fake then actually charges. The result carries the bytes (fake only) so a replay can rebuild the file.
export function createFakeImage(opts: FakeOptions & { priceMicroUsd?: number; quoteMicroUsd?: number } = {}): ImageProvider & FakeCounters {
  const s = createScript(opts);
  const QUOTE = opts.quoteMicroUsd ?? 4000;
  return {
    capability: { id: "fake-image", refImages: true, seed: true, aspects: ["9:16", "16:9", "1:1"], maxRefs: 3 },
    quote: () => QUOTE,
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async generate(ctx: StageContext, a) {
      return ctx.paid({ reserveMicroUsd: QUOTE, budgetScopes: scopesOf(a.budgetScopes), kind: "paid" }, async () => {
        const played = await s.play(`fake:image:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: opts.priceMicroUsd ?? QUOTE });
        const sha256 = createHash("sha256").update(`${a.aspect}\0${a.prompt}`).digest("hex");
        const imagePath = path.join(ctx.attemptDir, `image-${sha256.slice(0, 12)}.png`);
        await writeFile(imagePath, PNG);
        const result = { path: imagePath, bytes: PNG.length, sha256, b64: PNG.toString("base64"), provenance: { provider: "fake-image", model: a.model, params: { aspect: a.aspect }, priceMicroUsd: played.actualMicroUsd, quoted: true } };
        return { result, actualMicroUsd: played.actualMicroUsd };
      });
    },
  };
}
