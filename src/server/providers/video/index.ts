import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { lockedCharacterProblem, type ClipRequest, type VideoModelCap } from "@/server/core/video-clip";
import { KnownFailure } from "@/server/core/paid-call";
import type { StageContext } from "@/server/core/stage-handler";
import type { MediaArtifact } from "../media-types";

export const MAX_CLIP_BYTES = 500 * 1024 * 1024;

export interface VideoProviderCap {
  id: string;
  /** Every model this provider can run, by model id. */
  models: Readonly<Record<string, VideoModelCap>>;
}

export interface ClipArgs extends ClipRequest {
  model: string;
  /** Budget scopes (for example a video's quote cap). With none the call is refused: nothing would cap it. */
  budgetScopes: string[];
  /** Storage-relative paths (an asset's storageRef) of the start and end pictures; present exactly when startImage / endImage is true. */
  startImagePath?: string;
  endImagePath?: string;
}

// The adapter reserves the money itself (ctx.paid); the clip lands in the content-addressed generated-media folder. Always asks the provider for NO audio.
export interface VideoProvider {
  capability: VideoProviderCap;
  /** Micro-USD for one clip; refuses (KnownFailure) when unpriced or the request is unusable. */
  quote(a: ClipArgs): number;
  generate(ctx: StageContext, a: ClipArgs): Promise<MediaArtifact>;
}

/** The router: no fallback to another provider or model. A locked character needs a model that starts from a picture. */
export function pickVideoModel(providers: Record<string, VideoProvider>, providerId: string, modelId: string, flow: { locked: boolean }): { provider: VideoProvider; model: VideoModelCap } {
  const provider = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
  if (!provider) throw new KnownFailure("The video provider is not set up.");
  const model = Object.hasOwn(provider.capability.models, modelId) ? provider.capability.models[modelId] : undefined;
  if (!model) throw new KnownFailure(`The video model "${modelId.slice(0, 60)}" is not supported.`);
  if (flow.locked) {
    const why = lockedCharacterProblem(model);
    if (why) throw new KnownFailure(why);
  }
  return { provider, model };
}

/** Budget scopes for a paid clip; none is refused (fail closed). */
export function clipScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) throw new KnownFailure("No budget is set for this clip, so it was not requested.");
  return scopes;
}

/** An MP4 or MOV file starts with a size then "ftyp". */
export const isMp4 = (b: Buffer): boolean => b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp";

/**
 * Stored content-addressed under generated-media/<2 hex>/<sha>.mp4 with a sidecar, so a replay in a new attempt still finds the file.
 * A bad file after a paid call is an unknown outcome (plain Error): the money stays held until the owner decides.
 */
export async function saveClip(
  bytes: Buffer,
  m: { root: string; provider: string; model: string; prompt: string; seconds: number; aspect: string; priceMicroUsd: number; seed?: number },
): Promise<MediaArtifact> {
  if (!isMp4(bytes)) throw new Error(`${m.provider} returned something that is not an MP4 video.`);
  if (bytes.length > MAX_CLIP_BYTES) throw new Error(`${m.provider} returned a video over the 500 MB limit.`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(m.root, "generated-media", sha256.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha256}.mp4`);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file); // atomic; same name = same bytes
  await writeFile(path.join(dir, `${sha256}.json`), JSON.stringify({ prompt: m.prompt, model: m.model, seconds: m.seconds, aspect: m.aspect, seed: m.seed ?? null }), { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "EEXIST") throw e;
  });
  return {
    path: file, bytes: bytes.length, sha256, durationS: m.seconds,
    provenance: { provider: m.provider, model: m.model, params: { aspect: m.aspect, seconds: m.seconds, ...(m.seed !== undefined && { seed: m.seed }) }, priceMicroUsd: m.priceMicroUsd, quoted: true },
  };
}
