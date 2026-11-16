import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audioChunkArgs, checkSourceProbe, chunkPlan, looksLikeVideo, mergeChunkWords, probeSourceArgs, SOURCE_MAX_S, SOURCE_MIN_S, transcodeSourceArgs } from "@/server/core/source-ingest";
import { assertFfprobeAvailable } from "../support/tools";

const probe = (o: { format?: string; streams?: unknown[]; duration?: unknown; size?: unknown } = {}) =>
  JSON.stringify({
    format: { format_name: o.format ?? "mov,mp4,m4a,3gp,3g2,mj2", duration: o.duration ?? "120.5", size: o.size ?? "5000000" },
    streams: o.streams ?? [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }],
  });

describe("checkSourceProbe", () => {
  it("accepts a plain mp4/mov and a matroska/webm file with the facts", () => {
    expect(checkSourceProbe(probe())).toMatchObject({ ok: true, facts: { durationS: 120.5, width: 1920, height: 1080, sizeBytes: 5_000_000 } });
    expect(checkSourceProbe(probe({ format: "matroska,webm" })).ok).toBe(true);
  });
  it("refuses a playlist, a concat or image-sequence demuxer and anything else that is not a plain video container", () => {
    for (const f of ["hls,applehttp", "concat", "image2", "lavfi", "tty", "avi", "mpegts", "", "mov,mp4,m4a,3gp,3g2,mj2,extra"]) {
      expect(checkSourceProbe(probe({ format: f })), f).toMatchObject({ ok: false, reason: expect.stringMatching(/not a plain video file/) });
    }
  });
  it("refuses no video, no sound, a silly size, too short, too long and over 1 GB, in plain words", () => {
    expect(checkSourceProbe(probe({ streams: [{ codec_type: "audio" }] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no video picture/) });
    expect(checkSourceProbe(probe({ streams: [{ codec_type: "video", width: 640, height: 360 }] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/no sound/) });
    expect(checkSourceProbe(probe({ streams: [{ codec_type: "video", width: 99999, height: 360 }, { codec_type: "audio" }] }))).toMatchObject({ ok: false, reason: expect.stringMatching(/size is not usable/) });
    expect(checkSourceProbe(probe({ duration: String(SOURCE_MIN_S - 1) }))).toMatchObject({ ok: false, reason: expect.stringMatching(/too short/) });
    expect(checkSourceProbe(probe({ duration: String(SOURCE_MIN_S) })).ok).toBe(true);
    expect(checkSourceProbe(probe({ duration: String(SOURCE_MAX_S + 1) }))).toMatchObject({ ok: false, reason: expect.stringMatching(/minutes long/) });
    expect(checkSourceProbe(probe({ size: String(1024 ** 3 + 1) }))).toMatchObject({ ok: false, reason: expect.stringMatching(/over 1 GB/) });
    expect(checkSourceProbe(probe({ duration: "N/A" }))).toMatchObject({ ok: false });
    expect(checkSourceProbe("not json")).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read/) });
  });
});

describe("transcodeSourceArgs / audioChunkArgs", () => {
  it("keep to the file protocol, take only the first video and audio stream, drop metadata and refuse option-looking names", () => {
    const a = transcodeSourceArgs("/in/u.mp4", "/out/s.mp4");
    expect(a.slice(a.indexOf("-protocol_whitelist"), a.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
    expect(a.join(" ")).toContain("-map 0:v:0 -map 0:a:0");
    expect(a.join(" ")).toContain("-sn -dn -map_metadata -1");
    expect(a.at(-1)).toBe("/out/s.mp4");
    expect(() => transcodeSourceArgs("-i", "/out/s.mp4")).toThrow();
    expect(() => audioChunkArgs("/in/s.mp4", "-x.wav", { startS: 0, lenS: 60 })).toThrow();
    const c = audioChunkArgs("/in/s.mp4", "/out/c1.wav", { startS: 120, lenS: 60 });
    expect(c[c.indexOf("-ss") + 1]).toBe("120.000");
    expect(c.join(" ")).toContain("-ac 1 -ar 16000");
  });
});

describe("looksLikeVideo", () => {
  const bytes = (...b: number[]) => Uint8Array.from([...b, ...new Array(Math.max(0, 16 - b.length)).fill(0)]);
  it("accepts the mp4/mov and matroska/webm signatures and refuses everything else", () => {
    expect(looksLikeVideo(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d))).toBe(true);
    expect(looksLikeVideo(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe(true);
    expect(looksLikeVideo(new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3\n"))).toBe(false); // a playlist
    expect(looksLikeVideo(new TextEncoder().encode("GIF89a......ftyp"))).toBe(false);
    expect(looksLikeVideo(new Uint8Array(0))).toBe(false);
    expect(looksLikeVideo(bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79))).toBe(false); // too short to be sure
  });
});

describe("probeSourceArgs", () => {
  it("allows the file protocol only and refuses an option-looking name", () => {
    const a = probeSourceArgs("/in/u.mp4");
    expect(a.slice(a.indexOf("-protocol_whitelist"), a.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
    expect(a.at(-1)).toBe("/in/u.mp4");
    expect(() => probeSourceArgs("-x")).toThrow();
  });
});

describe("chunkPlan", () => {
  it("covers the whole video in whole chunks with a shorter last one", () => {
    expect(chunkPlan(150)).toEqual([{ startS: 0, lenS: 60 }, { startS: 60, lenS: 60 }, { startS: 120, lenS: 30 }]);
    expect(chunkPlan(60)).toEqual([{ startS: 0, lenS: 60 }]);
    expect(chunkPlan(0)).toEqual([]);
    expect(chunkPlan(Number.NaN)).toEqual([]);
    const total = chunkPlan(1799.5).reduce((s, c) => s + c.lenS, 0);
    expect(total).toBeCloseTo(1799.5, 5);
  });
});

describe("mergeChunkWords", () => {
  it("puts each chunk's words on the video timeline, in order, inside the video", () => {
    const r = mergeChunkWords([{ startS: 60, words: [{ word: " later ", startS: 1, endS: 1.4 }] }, { startS: 0, words: [{ word: "first", startS: 0.2, endS: 0.5 }, { word: "x", startS: 59.9, endS: 61 }] }], 100);
    expect(r.map((w) => w.word)).toEqual(["first", "x", "later"]);
    expect(r[0]).toEqual({ word: "first", startS: 0.2, endS: 0.5 });
    expect(r[2]).toEqual({ word: "later", startS: 61, endS: 61.4 });
  });
  it("drops empty and invalid words, clamps to the video, and never lets a word start before the one before it", () => {
    const r = mergeChunkWords([{ startS: 0, words: [{ word: "", startS: 1, endS: 2 }, { word: "a", startS: Number.NaN, endS: 2 }, { word: "b", startS: 5, endS: 4 }, { word: "c", startS: 99, endS: 130 }, { word: "d", startS: 4.99, endS: 5.2 }] }], 100);
    expect(r.map((w) => w.word)).toEqual(["b", "d", "c"].sort((x, y) => r.findIndex((w) => w.word === x) - r.findIndex((w) => w.word === y)));
    for (let i = 0; i < r.length; i++) {
      expect(r[i]!.endS).toBeGreaterThanOrEqual(r[i]!.startS);
      expect(r[i]!.endS).toBeLessThanOrEqual(100);
      if (i > 0) expect(r[i]!.startS).toBeGreaterThanOrEqual(r[i - 1]!.startS);
    }
  });
});

describe("with real ffmpeg", () => {
  let dir = "";
  beforeAll(() => {
    assertFfprobeAvailable();
    dir = mkdtempSync(path.join(tmpdir(), "ingest-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });
  const probeFile = (f: string) => checkSourceProbe(run("ffprobe", probeSourceArgs(f)).stdout);

  it("a real mp4 passes the probe check and its transcode is a fresh mp4 that passes again", () => {
    const up = path.join(dir, "up.mp4");
    expect(run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=2560x1440:rate=25:duration=24", "-f", "lavfi", "-i", "sine=frequency=300:duration=24", "-shortest", "-pix_fmt", "yuv420p", up]).status).toBe(0);
    expect(probeFile(up)).toMatchObject({ ok: true });
    const out = path.join(dir, "clean.mp4");
    const t = run("ffmpeg", transcodeSourceArgs(up, out));
    expect(t.status, t.stderr).toBe(0);
    const clean = probeFile(out);
    expect(clean).toMatchObject({ ok: true, facts: { width: 1920 } }); // scaled down to at most 1920 wide
  }, 120_000);

  it("a playlist and a text file are refused by the probe check, never transcoded", () => {
    const m3u8 = path.join(dir, "evil.m3u8");
    writeFileSync(m3u8, "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n/etc/hosts\n#EXT-X-ENDLIST\n");
    expect(probeFile(m3u8).ok).toBe(false);
    const txt = path.join(dir, "a.mp4");
    writeFileSync(txt, "not a video");
    expect(probeFile(txt).ok).toBe(false);
  });
});
