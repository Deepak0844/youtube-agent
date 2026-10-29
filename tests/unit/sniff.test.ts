import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rejectionMessage, sniff } from "@/server/core/sniff";

const fx = (n: string) => new Uint8Array(readFileSync(path.join(process.cwd(), "tests/fixtures/assets", n)).subarray(0, 4096));
const bytes = (...v: number[]) => new Uint8Array([...v, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

describe("sniff (magic bytes only)", () => {
  it("accepts the allow-listed image and audio types", () => {
    expect(sniff(fx("portrait-exif-gps.jpg"))).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(sniff(fx("plain.png"))).toEqual({ kind: "image", mime: "image/png" });
    expect(sniff(fx("plain.webp"))).toEqual({ kind: "image", mime: "image/webp" });
    expect(sniff(fx("animated.gif"))).toEqual({ kind: "image", mime: "image/gif" });
    expect(sniff(fx("tone.wav"))).toEqual({ kind: "audio", mime: "audio/wav" });
    expect(sniff(fx("tone.mp3"))).toEqual({ kind: "audio", mime: "audio/mpeg" });
    expect(sniff(fx("tone.m4a"))).toEqual({ kind: "audio", mime: "audio/mp4" });
    expect(sniff(fx("tone.flac"))).toEqual({ kind: "audio", mime: "audio/flac" });
    expect(sniff(bytes(0xff, 0xfb, 0x90))).toEqual({ kind: "audio", mime: "audio/mpeg" }); // bare MP3 frame sync, no ID3
  });
  it("rejects svg, html, heic and video with a reason", () => {
    expect(sniff(fx("vector.svg"))).toEqual({ rejected: "svg" });
    expect(sniff(new TextEncoder().encode("\n  <!DOCTYPE html><html><body>x</body></html>"))).toEqual({ rejected: "html" });
    expect(sniff(new TextEncoder().encode("\ufeff<?xml version='1.0'?><svg xmlns='x'/>"))).toEqual({ rejected: "svg" });
    expect(sniff(fx("photo.heic"))).toEqual({ rejected: "heic" });
    const mp4 = new Uint8Array(24);
    mp4.set(new TextEncoder().encode("ftypisom"), 4);
    expect(sniff(mp4)).toEqual({ rejected: "video" });
  });
  it("an image with a web page smuggled in is rejected", () => {
    expect(sniff(fx("polyglot.gif"))).toEqual({ rejected: "html" });
  });
  it("unknown, empty and reserved MPEG headers are rejected", () => {
    expect(sniff(new Uint8Array())).toEqual({ rejected: "unknown" });
    expect(sniff(new TextEncoder().encode("hello world"))).toEqual({ rejected: "unknown" });
    expect(sniff(bytes(0xff, 0xe1))).toEqual({ rejected: "unknown" }); // layer bits 00 are reserved
  });
  it("every rejection has a plain message", () => {
    expect(rejectionMessage("heic")).toMatch(/JPEG or PNG/);
    for (const r of ["svg", "html", "heic", "unknown", "video"] as const) expect(rejectionMessage(r).length).toBeGreaterThan(10);
  });
});
