import sharp from "sharp";
import { STILL_HEIGHT, STILL_WIDTH } from "@/server/core/scene3d-stills";
import type { RawPicture } from "@/server/core/scene3d-look-check";

/**
 * A preview picture as raw RGB. The bytes come from our own native renderer and were already checked (a PNG, exactly 540x960, at most
 * 2 MB), and the decoder is told to refuse anything bigger, so decoding here in the worker is bounded. Throws on anything unreadable.
 */
export async function decodeStill(png: Uint8Array): Promise<RawPicture> {
  const { data, info } = await sharp(png, { limitInputPixels: STILL_WIDTH * STILL_HEIGHT, failOn: "error" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3 || info.width !== STILL_WIDTH || info.height !== STILL_HEIGHT) throw new RangeError("the preview picture is not 540x960 RGB");
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}
