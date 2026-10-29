import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { StageContext } from "@/server/core/stage-handler";
import { createScript, type FakeCounters, type FakeOptions } from "../fake-base";
import type { MediaArtifact } from "../media-types";
import { silentWav } from "../voice/fake";
import { GENERATED_LICENCE } from "./elevenlabs";
import type { SoundProvider } from "./index";

/** Deterministic tone (not silence, so loudness can be measured). */
export function createFakeSound(opts: FakeOptions & { priceMicroUsd?: number } = {}): SoundProvider & FakeCounters {
  const s = createScript(opts);
  const price = opts.priceMicroUsd ?? 2000;
  async function make(kind: "sfx" | "music", ctx: StageContext, a: { prompt: string; seconds: number }): Promise<MediaArtifact> {
    const played = await s.play(`fake:${kind}:${ctx.claim.stageRunId}`, ctx.signal, { actualMicroUsd: price });
    const wav = silentWav(a.seconds);
    for (let i = 44; i < wav.length; i++) wav[i] = i % 2 ? 168 : 88;
    const file = path.join(ctx.attemptDir, `${kind}-${createHash("sha256").update(`${a.seconds}\0${a.prompt}`).digest("hex").slice(0, 12)}.wav`);
    await writeFile(file, wav);
    return { path: file, bytes: wav.length, sha256: createHash("sha256").update(wav).digest("hex"), provenance: { provider: `fake_${kind}`, params: { ...a }, priceMicroUsd: played.actualMicroUsd, quoted: false, licence: GENERATED_LICENCE } };
  }
  return {
    calls: s.calls, totalCalls: s.totalCalls, dbCalls: s.dbCalls,
    quoteSfx: () => price, quoteMusic: () => price,
    makeSfx: (ctx, a) => make("sfx", ctx, a),
    makeMusic: (ctx, a) => make("music", ctx, a),
  };
}
