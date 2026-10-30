import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NotProcessedError } from "@/server/core/error-class";
import { isPriced, type PriceRule } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import { sniff, SNIFF_HEAD_BYTES } from "@/server/core/sniff";
import type { StageContext } from "@/server/core/stage-handler";
import type { MediaArtifact } from "../media-types";
import type { ImageProvider } from "../media";

export const MAX_PROMPT = 1000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Plain text: control characters removed and trimmed; null when empty or over 1000 code points. */
export function cleanImagePrompt(raw: string): string | null {
  const t = raw.replace(/\p{Cc}/gu, "").trim();
  return t === "" || Array.from(t).length > MAX_PROMPT ? null : t;
}

/** Everything refused before money is reserved or a request is built. Returns the cleaned prompt. */
export function checkImage(cap: ImageProvider["capability"], price: PriceRule | null, a: { prompt: string; aspect: string; refs?: string[]; seed?: number }): string {
  if (!isPriced(price) || price.unit !== "per_image") throw new KnownFailure(`${cap.id} has no price set, so it cannot be used.`);
  const prompt = cleanImagePrompt(a.prompt);
  if (prompt === null) throw new KnownFailure(`An image needs a description of 1 to ${MAX_PROMPT} characters.`);
  if (!(cap.aspects as string[]).includes(a.aspect)) throw new KnownFailure("This image shape is not supported by the provider.");
  if ((a.refs?.length ?? 0) > (cap.refImages ? cap.maxRefs : 0)) throw new KnownFailure(`This provider takes at most ${cap.refImages ? cap.maxRefs : 0} reference images.`);
  if (a.seed !== undefined && (!cap.seed || !Number.isInteger(a.seed) || a.seed < 0 || a.seed > 0xffffffff)) throw new KnownFailure("This provider does not take that seed.");
  return prompt;
}

/** A placeholder list of `n` references for quoting; a bad count is a refusal, not a RangeError. */
export function refsOf(n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new KnownFailure("The reference image count is not valid.");
  return new Array<string>(n).fill("");
}

/** The router: a locked-character flow needs a provider that takes reference images; no fallback to another provider. */
export function pickImageProvider(providers: Record<string, ImageProvider>, id: string, flow: { locked: boolean }): ImageProvider {
  const p = Object.hasOwn(providers, id) ? providers[id] : undefined;
  if (!p) throw new KnownFailure("The image provider is not set up.");
  if (flow.locked && !p.capability.refImages) throw new KnownFailure("This image provider cannot keep a character's look. Choose one that takes reference images.");
  return p;
}

/** The decrypted key, per call. A missing key is a refusal before anything was sent. */
export async function readKey(getKey: () => Promise<string>, who: string): Promise<string> {
  let key: string;
  try {
    key = await getKey();
  } catch {
    throw new NotProcessedError(`The ${who} key could not be read.`);
  }
  if (!key) throw new NotProcessedError(`No ${who} key is saved.`);
  return key;
}

/** Budget scopes for a paid call; none means nothing would cap it, so it is refused (fail closed). */
export function scopesOf(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) throw new KnownFailure("No budget is set for this image, so it was not requested.");
  return scopes;
}

/**
 * Magic bytes decide (png/jpeg/webp, at most 25 MB). Written to a content-addressed place under the storage root that outlives the attempt
 * (`generated-media/<2 hex>/<sha>.<ext>`, a sidecar beside it), so a replay of the stored result in a new attempt still finds the file.
 * The name is the hash, so an existing file already holds these bytes. A bad image after a paid call is an unknown outcome (plain Error).
 */
export async function saveImage(
  bytes: Buffer,
  m: { root: string; provider: string; model: string; prompt: string; refs: string[]; seed?: number; aspect?: string; priceMicroUsd: number; licence?: string },
): Promise<MediaArtifact> {
  const s = sniff(bytes.subarray(0, SNIFF_HEAD_BYTES));
  const ext = "kind" in s && s.kind === "image" ? EXT[s.mime] : undefined;
  if (!ext) throw new Error(`${m.provider} returned something that is not a PNG, JPEG or WebP image.`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${m.provider} returned an image over the 25 MB limit.`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(m.root, "generated-media", sha256.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha256}.${ext}`);
  const put = async (target: string, data: Buffer | string) => {
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target); // atomic; same name = same bytes
  };
  await put(file, bytes);
  await writeFile(path.join(dir, `${sha256}.json`), JSON.stringify({ prompt: m.prompt, model: m.model, refs: m.refs, seed: m.seed ?? null }), { flag: "wx" }).catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
  return {
    path: file, bytes: bytes.length, sha256,
    provenance: { provider: m.provider, model: m.model, params: { ...(m.aspect && { aspect: m.aspect }), ...(m.seed !== undefined && { seed: m.seed }) }, priceMicroUsd: m.priceMicroUsd, quoted: true, licence: m.licence ?? `generated with ${m.provider} under the owner's plan; check plan terms for commercial use` },
  };
}

/** One synchronous paid request: reserve = quote, key per call, the body must decode to an image. The outcome is unknown whenever the socket or body fails. */
export async function paidImage(
  ctx: StageContext, d: { who: string; root: string; getKey: () => Promise<string>; budgetScopes: string[] }, reserve: number,
  request: (key: string, signal: AbortSignal) => Promise<Buffer>, meta: Omit<Parameters<typeof saveImage>[1], "priceMicroUsd" | "root">,
): Promise<MediaArtifact> {
  return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: d.budgetScopes, kind: "paid" }, async (_callKey, signal) => {
    const bytes = await request(await readKey(d.getKey, d.who), signal);
    return { result: await saveImage(bytes, { ...meta, root: d.root, priceMicroUsd: reserve }), actualMicroUsd: reserve };
  });
}
