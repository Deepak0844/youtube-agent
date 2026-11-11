import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { clipProblem, quoteClip, type VideoModelCap } from "@/server/core/video-clip";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import { clipScopes, type ClipArgs, type VideoProvider } from "./index";

// Not a playable video: only the "ftyp" header, enough for the file check. The fake never calls anything.
export const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypisom", "latin1"), Buffer.from([0, 0, 0, 0])]);

export const FAKE_MODEL: VideoModelCap = { id: "fake-video", imageToVideo: true, endFrame: true, audio: false, aspects: ["9:16", "16:9", "1:1"], minSeconds: 2, maxSeconds: 10 };
/** A model that cannot start from a picture, to test the locked-character refusal. */
export const FAKE_TEXT_ONLY_MODEL: VideoModelCap = { id: "fake-text-only", imageToVideo: false, endFrame: false, audio: false, aspects: ["9:16"], minSeconds: 2, maxSeconds: 8 };

// Same call shape as the real adapters. `price` is the owner's per-second rule (default 100000 micro-USD = $0.10 per second); `priceMicroUsd` is what the fake actually charges.
export function createFakeVideo(opts: FakeOptions & { price?: unknown; priceMicroUsd?: number } = {}): VideoProvider & FakeCounters {
  const s = createScript(opts);
  const price = "price" in opts ? opts.price : { unit: "per_second", microUsd: 100_000 };
  const models = { [FAKE_MODEL.id]: FAKE_MODEL, [FAKE_TEXT_ONLY_MODEL.id]: FAKE_TEXT_ONLY_MODEL };
  const check = (a: ClipArgs) => {
    const cap = Object.hasOwn(models, a.model) ? models[a.model] : undefined;
    if (!cap) throw new KnownFailure(`The video model "${a.model.slice(0, 60)}" is not supported.`);
    const why = clipProblem(cap, a);
    if (why) throw new KnownFailure(why);
    return quoteClip(price, a.seconds);
  };
  return {
    capability: { id: "fake-video", models },
    quote: check,
    calls: s.calls,
    totalCalls: s.totalCalls,
    dbCalls: s.dbCalls,
    async generate(ctx: StageContext, a: ClipArgs) {
      const quote = check(a);
      return ctx.paid({ reserveMicroUsd: quote, budgetScopes: clipScopes(a.budgetScopes), kind: "paid" }, async () => {
        const played = await s.play(`fake:video:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: opts.priceMicroUsd ?? quote });
        const sha256 = createHash("sha256").update(`${a.model}\0${a.aspect}\0${a.seconds}\0${a.prompt}`).digest("hex");
        const clipPath = path.join(ctx.attemptDir, `clip-${sha256.slice(0, 12)}.mp4`);
        await writeFile(clipPath, FAKE_MP4);
        const result = { path: clipPath, bytes: FAKE_MP4.length, sha256, durationS: a.seconds, provenance: { provider: "fake-video", model: a.model, params: { aspect: a.aspect, seconds: a.seconds }, priceMicroUsd: played.actualMicroUsd, quoted: true } };
        return { result, actualMicroUsd: played.actualMicroUsd };
      });
    },
  };
}
