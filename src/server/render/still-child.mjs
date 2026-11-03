// Runs INSIDE a child process started by tsx-render.ts (via runChild): decodes one preflight still (a PNG the TSX render
// container wrote, so untrusted bytes) into raw RGB, 3 bytes per pixel. A decoder crash, hang or memory blow-up kills this
// child, never the worker. The input is a host-side copy (no symlink followed); pixels beyond width x height are refused.
// Optional 5th argument <jpegOut>: also writes a half-size (width/2 x height/2) JPEG of the same picture for the frame review.
// Usage: node still-child.mjs <png> <rawOut> <width> <height> [jpegOut]. Prints one JSON line: { ok: true } or { ok: false, message }.
import { writeFile } from "node:fs/promises";
import sharp from "sharp";

const [src, dest, w, h, jpegOut] = process.argv.slice(2);
const width = Number(w);
const height = Number(h);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
sharp.cache(false);
sharp.concurrency(1);

try {
  if (!src || !dest || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4096 * 4096) throw new Error("usage");
  const { data, info } = await sharp(src, { limitInputPixels: width * height, failOn: "error" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || info.channels !== 3 || data.length !== width * height * 3) {
    out({ ok: false, message: `The still is ${info.width}x${info.height}, expected ${width}x${height}.` });
  } else {
    await writeFile(dest, data, { flag: "wx", mode: 0o600 });
    if (jpegOut) {
      const jpeg = await sharp(data, { raw: { width, height, channels: 3 } }).resize(Math.round(width / 2), Math.round(height / 2)).jpeg({ quality: 72 }).toBuffer();
      await writeFile(jpegOut, jpeg, { flag: "wx", mode: 0o600 });
    }
    out({ ok: true });
  }
} catch {
  out({ ok: false, message: "The still could not be decoded." });
}
