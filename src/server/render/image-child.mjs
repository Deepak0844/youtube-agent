// Runs INSIDE a child process started by ingestImage (via runChild): the only place untrusted image bytes are decoded.
// A decoder crash, hang or memory blow-up therefore kills this child, never the worker or the web process.
// Usage: node image-child.mjs <srcPath> <destDir> <maxPixels>
// Prints exactly one JSON line: { ok: true, mime, width, height, bytes, files: { role: fileName } } or { ok: false, reason, message }.
import { rm } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const [src, destDir, maxPixelsArg] = process.argv.slice(2);
const maxPixels = Number(maxPixelsArg);
const made = [];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const fail = async (reason, message) => {
  await Promise.all(made.map((f) => rm(path.join(destDir, f), { force: true })));
  out({ ok: false, reason, message });
};

sharp.cache(false);
sharp.concurrency(1);

const CROPS = [
  ["crop_916", 9 / 16, 1080, 1920],
  ["crop_169", 16 / 9, 1920, 1080],
];

try {
  const opts = { limitInputPixels: maxPixels, failOn: "error" };
  const meta = await sharp(src, opts).metadata();
  if (!meta.width || !meta.height) {
    await fail("decode_failed", "The image has no size.");
  } else if (meta.width * meta.height > maxPixels) {
    await fail("too_many_pixels", "The image has too many pixels.");
  } else {
    // Orientation is applied FIRST (rotate with no argument reads EXIF); sharp then writes no metadata at all (no EXIF, GPS, ICC, XMP).
    const pipeline = () => sharp(src, opts).rotate().toColourspace("srgb");
    const opaque = meta.hasAlpha ? (await sharp(src, opts).stats()).isOpaque : true;
    const mainName = opaque ? "main.jpg" : "main.png";
    made.push(mainName);
    const info = await (opaque ? pipeline().jpeg({ quality: 90, mozjpeg: false }) : pipeline().png()).toFile(path.join(destDir, mainName));
    const files = { main: mainName };
    const mainPath = path.join(destDir, mainName);
    const webp = async (role, img) => {
      const name = `${role}.webp`;
      made.push(name);
      await img.webp({ quality: 85 }).toFile(path.join(destDir, name));
      files[role] = name;
    };
    await webp("preview", sharp(mainPath).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }));
    await webp("thumb", sharp(mainPath).resize({ width: 320, height: 320, fit: "inside", withoutEnlargement: true }));
    for (const [role, ratio, maxW, maxH] of CROPS) {
      let cw = info.width;
      let ch = info.height;
      if (info.width / info.height > ratio) cw = Math.max(1, Math.round(info.height * ratio));
      else ch = Math.max(1, Math.round(info.width / ratio));
      const left = Math.floor((info.width - cw) / 2);
      const top = Math.floor((info.height - ch) / 2);
      await webp(role, sharp(mainPath).extract({ left, top, width: cw, height: ch }).resize({ width: maxW, height: maxH, fit: "inside", withoutEnlargement: true }));
    }
    out({ ok: true, mime: opaque ? "image/jpeg" : "image/png", width: info.width, height: info.height, bytes: info.size, files });
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/pixel limit/i.test(msg)) await fail("too_many_pixels", "The image has too many pixels.");
  else await fail("decode_failed", "The image could not be read; it may be damaged or cut short.");
}
