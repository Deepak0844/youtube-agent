import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { alphaOf, MAX_CUTOUT_PIXELS, polishRgba, transparentShare, whiteKeyMask, type CutoutOptions } from "@/server/core/cutout";

const run = promisify(execFile);
const CHILD = fileURLToPath(new URL("./cutout-child.mjs", import.meta.url));
export const MODEL_TIMEOUT_MS = 180_000;

export class CutoutRefused extends Error {}

/** The background remover, in its own process. Reads one picture file, writes one PNG with see-through background. */
export type Matte = (inPath: string, outPath: string, signal?: AbortSignal) => Promise<void>;

export const modelMatte: Matte = async (inPath, outPath, signal) => {
  try {
    await run(process.execPath, [CHILD, inPath, outPath], { timeout: MODEL_TIMEOUT_MS, maxBuffer: 64 * 1024, signal, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "production" } });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new CutoutRefused("The background remover could not finish this picture. Try the white-background method, or another picture.");
  }
};

const decode = async (input: Buffer | string) => {
  const { data, info } = await sharp(input, { limitInputPixels: MAX_CUTOUT_PIXELS, failOn: "error" }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
};

/**
 * A cut-out PNG from a picture's bytes. "model" runs the background remover (`matte`), "white" keys out a white background that touches the edge.
 * Then the polish. Refuses, with a plain sentence, a picture where nothing or almost everything would be cut out, or where nothing is left.
 */
export async function cutoutPng(source: Buffer, o: CutoutOptions, matte: Matte = modelMatte, signal?: AbortSignal): Promise<Buffer> {
  let img: Awaited<ReturnType<typeof decode>>;
  try {
    img = await decode(source);
  } catch {
    throw new CutoutRefused("This picture could not be read, or it has too many pixels (over 16 million).");
  }
  let { rgba } = img;
  const { width, height } = img;
  if (o.method === "white") {
    const mask = whiteKeyMask(rgba, width, height, o.tolerance);
    rgba = rgba.slice();
    for (let i = 0; i < mask.length; i++) rgba[i * 4 + 3] = Math.min(rgba[i * 4 + 3]!, mask[i]!);
  } else {
    const dir = await mkdtemp(path.join(tmpdir(), "cutout-"));
    try {
      const inPath = path.join(dir, "in.png");
      const outPath = path.join(dir, "out.png");
      await writeFile(inPath, await sharp(source, { limitInputPixels: MAX_CUTOUT_PIXELS }).rotate().png().toBuffer());
      await matte(inPath, outPath, signal);
      const m = await decode(await readFile(outPath));
      if (m.width !== width || m.height !== height) throw new CutoutRefused("The background remover answered with a different size.");
      rgba = m.rgba;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const share = transparentShare(alphaOf(rgba));
  if (share < 0.02) throw new CutoutRefused(o.method === "white" ? "No white background was found around the edge, so nothing was cut out. Raise the tolerance, or use the model." : "The model found no background to remove in this picture.");
  if (share > 0.98) throw new CutoutRefused("Almost the whole picture would be removed. Try the other method or a different picture.");
  const polished = polishRgba(rgba, width, height, o);
  if (!polished) throw new CutoutRefused("Nothing is left after the edge is trimmed. Lower the edge setting.");
  return sharp(Buffer.from(polished.rgba.buffer, polished.rgba.byteOffset, polished.rgba.byteLength), { raw: { width: polished.width, height: polished.height, channels: 4 } }).png().toBuffer();
}
