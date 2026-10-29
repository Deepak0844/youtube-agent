// Regenerates tests/fixtures/video/*.mp4 (default) or, with the argument "assets", tests/fixtures/assets/* (upload ingest fixtures:
// images and audio, some deliberately hostile or broken; needs sharp and ffmpeg).
// Regenerates tests/fixtures/video/*.mp4 (small test clips for the fake renderer and the QA tests).
// Run: npx tsx scripts/make-fixtures.mts   (needs ffmpeg on PATH; CI uses the render image's ffmpeg the same way).
// Output is not bit-for-bit reproducible across ffmpeg versions; the committed files are what tests rely on, and
// tests/unit/fakes.test.ts probes them (size, length, audio, loop seam) so a bad regeneration is caught.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import path from "node:path";


async function makeAssets(): Promise<void> {
  const dir = path.resolve(process.cwd(), "tests/fixtures/assets");
  mkdirSync(dir, { recursive: true });
  const w = (n: string, b: Buffer | string) => writeFileSync(path.join(dir, n), b);
  const ffa = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", "-bitexact", ...args], { stdio: "inherit" });
  const half = (w1: number, h1: number, left: [number, number, number], right: [number, number, number]) => {
    const px = Buffer.alloc(w1 * h1 * 3);
    for (let y = 0; y < h1; y++) for (let x = 0; x < w1; x++) px.set(x < w1 / 2 ? left : right, (y * w1 + x) * 3);
    return sharp(px, { raw: { width: w1, height: h1, channels: 3 } });
  };
  // Stored 60x40 landscape, left half red and right half blue, EXIF orientation 6 (rotate 90 clockwise) and GPS: shown as 40x60 portrait, red on top.
  w("portrait-exif-gps.jpg", await half(60, 40, [255, 0, 0], [0, 0, 255]).withExif({ IFD0: { Orientation: "6", Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "77/1 35/1 0/1" } }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer());
  w("plain.png", await half(50, 30, [0, 200, 0], [0, 0, 200]).png().toBuffer());
  w("alpha.png", await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer());
  w("plain.webp", await half(50, 30, [200, 0, 200], [0, 200, 200]).webp().toBuffer());
  // Animated GIF: first frame red, then green, then blue.
  const frames = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  ffa(...frames.flatMap(([r, g, b]) => ["-f", "lavfi", "-i", `color=c=0x${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}:s=32x32:r=2:d=0.5`]), "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-loop", "0", path.join(dir, "animated.gif"));
  // Noisy picture cut in half: a real JPEG whose data ends early.
  const noise = Buffer.alloc(120 * 120 * 3);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise[i] = seed >> 16; }
  const full = await sharp(noise, { raw: { width: 120, height: 120, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  w("truncated.jpg", full.subarray(0, Math.floor(full.length / 2)));
  // A valid GIF followed by a web page: must never be trusted as an image.
  w("polyglot.gif", Buffer.concat([readFileSync(path.join(dir, "animated.gif")), Buffer.from("\n<html><script>alert(document.cookie)</script></html>\n")]));
  // A real 7746 x 7746 (60 MP) PNG that is nearly all one colour, so it is only about 7 KB: the pixel limit must stop it before any decode.
  w("huge-60mp.png", await sharp({ create: { width: 7746, height: 7746, channels: 3, background: "#336699" } }).png({ compressionLevel: 9, palette: true, colours: 2 }).toBuffer());
  w("vector.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
  const ftyp = (brand: string) => { const b = Buffer.alloc(24); b.writeUInt32BE(24); b.write("ftyp", 4); b.write(brand, 8); b.write("mif1", 16); return b; };
  w("photo.heic", ftyp("heic"));
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"];
  ffa(...tone, "-ar", "22050", "-ac", "1", "-map_metadata", "-1", path.join(dir, "tone.wav"));
  ffa(...tone, "-ac", "1", "-metadata", "title=Secret title", "-c:a", "libmp3lame", "-b:a", "64k", path.join(dir, "tone.mp3"));
  ffa(...tone, "-ac", "1", "-c:a", "aac", "-b:a", "48k", "-f", "ipod", path.join(dir, "tone.m4a"));
  ffa(...tone, "-ac", "1", path.join(dir, "tone.flac"));
  // Valid MP4 container with only a video stream, relabelled M4A: sniffs as audio, has no audio stream.
  ffa("-f", "lavfi", "-i", "color=c=blue:s=64x64:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "mp4", path.join(dir, "video-only.m4a"));
  const vo = readFileSync(path.join(dir, "video-only.m4a"));
  vo.write("M4A ", 8, "latin1");
  w("video-only.m4a", vo);
  // WAV header followed by garbage.
  w("bad.wav", Buffer.concat([Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1"), Buffer.from("not really audio, just bytes".repeat(4))]));
}

if (process.argv[2] === "assets") {
  await makeAssets();
  process.exit(0);
}

const out = path.resolve(process.cwd(), "tests/fixtures/video");
mkdirSync(out, { recursive: true });
const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
const tone = (s: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${s},volume=0.3`];
const still = (size: string, s: number) => ["-f", "lavfi", "-i", `color=c=blue:s=${size}:r=10:d=${s}`];
const v = ["-c:v", "libx264", "-preset", "veryslow", "-crf", "35", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const a = ["-c:a", "aac", "-b:a", "24k", "-ac", "1", "-shortest"];

// good: 20 s, 1080x1920, tone, still colour so first and last frame are identical.
ff(...still("1080x1920", 20), ...tone(20), ...v, ...a, path.join(out, "good.mp4"));
// short: right size and audio, only 3 s (below the 15 s minimum).
ff(...still("1080x1920", 3), ...tone(3), ...v, ...a, path.join(out, "short.mp4"));
// wrong-size: 640x360, 20 s, audio.
ff(...still("640x360", 20), ...tone(20), ...v, ...a, path.join(out, "wrong-size.mp4"));
// no-audio: right size and length, no audio track.
ff(...still("1080x1920", 20), ...v, "-an", path.join(out, "no-audio.mp4"));
// loop-mismatch: brightness ramps from black to white, so the last frame differs from the first.
ff("-f", "lavfi", "-i", "color=c=gray:s=1080x1920:r=10:d=20", ...tone(20), "-vf", "format=yuv420p,geq=lum='255*T/20':cb=128:cr=128", ...v, ...a, path.join(out, "loop-mismatch.mp4"));
// corrupt: a real clip cut off after 2 KB (header without a usable body).
writeFileSync(path.join(out, "corrupt.mp4"), readFileSync(path.join(out, "good.mp4")).subarray(0, 2048));
