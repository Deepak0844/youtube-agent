import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runChild } from "@/server/render/child";
import { mediaDurationS } from "@/server/render/media-duration";
import { assertFfprobeAvailable } from "../support/tools";

// A real ffprobe: a playlist saved as .mp3 must not lead it to another local file (only that file's length could leak, but
// the probe must not open it at all).

let dir: string;
beforeAll(() => {
  assertFfprobeAvailable();
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "media-duration-")));
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=d=7", path.join(dir, "secret.wav")]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=d=3", path.join(dir, "voice.wav")]);
  writeFileSync(path.join(dir, "concat.mp3"), "ffconcat version 1.0\nfile 'secret.wav'\n");
  writeFileSync(path.join(dir, "trick.mp3"), `#EXTM3U\n#EXT-X-TARGETDURATION:7\n#EXTINF:7.0,\n${path.join(dir, "secret.wav")}\n#EXT-X-ENDLIST\n`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const deps = () => ({ runChild: (s: Parameters<typeof runChild>[0]) => runChild(s), signal: new AbortController().signal, stageRunId: "media-duration-test" });

describe("mediaDurationS with a real ffprobe", () => {
  it("reads a real file's length", async () => {
    expect(Math.abs((await mediaDurationS(path.join(dir, "voice.wav"), deps()))! - 3)).toBeLessThan(0.05);
  });

  it("a_playlist_named_mp3_is_not_followed", async () => {
    const d = await mediaDurationS(path.join(dir, "trick.mp3"), deps());
    expect(d === null || Math.abs(d - 7) > 0.5).toBe(true);
  });

  it("a_concat_list_named_mp3_is_refused", async () => {
    expect(await mediaDurationS(path.join(dir, "concat.mp3"), deps())).toBeNull();
  });
});
