import { describe, expect, it } from "vitest";
import { mediaDurationS } from "@/server/render/media-duration";
import type { ChildSpec } from "@/server/render/child";

// The length of a staged media file, read with ffprobe through the child runner. The demuxer is forced from the file's
// extension, so ffprobe never auto-detects a playlist or concat list hidden behind a media name (it could open other files).

const fake = (out: string, code = 0) => {
  const calls: ChildSpec[] = [];
  const runChild = async (spec: ChildSpec) => {
    calls.push(spec);
    spec.onLine?.(out);
    return { code, signal: null, truncated: false, timedOut: false, aborted: false };
  };
  return { calls, deps: { runChild, signal: new AbortController().signal, stageRunId: "s1" } };
};

describe("mediaDurationS", () => {
  it("forces_the_demuxer_from_the_extension", async () => {
    for (const [file, fmt] of [["/w/assets/a.wav", "wav"], ["/w/assets/b.MP3", "mp3"], ["/w/assets/c.m4a", "mov"], ["/w/assets/d.mp4", "mov"], ["/w/assets/e.flac", "flac"], ["/w/assets/f.ogg", "ogg"], ["/w/assets/g.webm", "webm"]] as const) {
      const { calls, deps } = fake("12.5");
      expect(await mediaDurationS(file, deps)).toBe(12.5);
      expect(calls[0]!.command).toBe("ffprobe");
      expect(calls[0]!.args).toEqual(["-v", "error", "-protocol_whitelist", "file", "-f", fmt, "-show_entries", "format=duration", "-of", "csv=p=0", file]);
      expect(calls[0]!.timeoutMs).toBe(20_000);
      expect(calls[0]!.maxOutputBytes).toBe(64 * 1024);
      expect(calls[0]!.cwd).toBe("/w/assets");
    }
  });

  it("refuses_other_extensions_without_running_anything", async () => {
    for (const file of ["/w/assets/a.m3u8", "/w/assets/a.txt", "/w/assets/a", "relative.wav"]) {
      const { calls, deps } = fake("1");
      expect(await mediaDurationS(file, deps)).toBeNull();
      expect(calls).toHaveLength(0);
    }
  });

  it("gives_null_on_errors_and_unreadable_output", async () => {
    expect(await mediaDurationS("/w/a.wav", fake("", 1).deps)).toBeNull();
    expect(await mediaDurationS("/w/a.wav", fake("N/A").deps)).toBeNull();
    expect(await mediaDurationS("/w/a.wav", fake("-3").deps)).toBeNull();
  });
});
