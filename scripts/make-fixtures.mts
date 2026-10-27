// Regenerates tests/fixtures/video/*.mp4 (small test clips for the fake renderer and the QA tests).
// Run: npx tsx scripts/make-fixtures.mts   (needs ffmpeg on PATH; CI uses the render image's ffmpeg the same way).
// Output is not bit-for-bit reproducible across ffmpeg versions; the committed files are what tests rely on, and
// tests/unit/fakes.test.ts probes them (size, length, audio, loop seam) so a bad regeneration is caught.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
