import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runChild } from "@/server/render/child";
import { alignChunk } from "@/server/render/whisper";

// Real whisper-cli on clips built like the ADR 0008 spike (each word spoken alone, known gaps, so reference times are exact).
// Needs whisper-cli, ffmpeg, macOS `say` and WHISPER_MODEL=<path to ggml-medium.bin>; skipped otherwise (CI has none of them).
const MODEL = process.env.WHISPER_MODEL ?? "";
const have = (cmd: string): boolean => { try { execFileSync("which", [cmd], { stdio: "ignore" }); return true; } catch { return false; } };
const can = MODEL !== "" && existsSync(MODEL) && have("whisper-cli") && have("ffmpeg") && have("say");

const CLIPS = [
  { lang: "en", voice: "Samantha", text: "Hello friends today we will talk about the moon The moon is the only natural satellite" },
  { lang: "hi", voice: "Lekha", text: "नमस्ते दोस्तों आज हम चाँद के बारे में बात करेंगे चाँद पृथ्वी का एकमात्र प्राकृतिक उपग्रह है" },
  { lang: "ta", voice: "Vani", text: "வணக்கம் நண்பர்களே இன்று நாம் நிலவைப் பற்றி பேசப்போகிறோம் நிலவு பூமியின் ஒரே இயற்கை துணைக்கோள் ஆகும்" },
] as const;
const SR = 16000;
const GAPS = [90, 140, 200, 120, 260, 110];

function pcm(file: string): Int16Array {
  const b = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-ar", String(SR), "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  return new Int16Array(b.buffer, b.byteOffset, b.length >> 1).slice();
}
function trim(a: Int16Array): Int16Array {
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]!) < 330) s++;
  while (e > s && Math.abs(a[e]!) < 330) e--;
  return a.slice(s, e + 1);
}
function wav(a: Int16Array): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + a.length * 2, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(a.length * 2, 40);
  return Buffer.concat([h, Buffer.from(a.buffer, a.byteOffset, a.byteLength)]);
}

describe.skipIf(!can)("whisper-cli alignment (real)", () => {
  it.each(CLIPS)("$lang median cut error stays in the spike's band (under 100 ms)", async ({ lang, voice, text }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "whisper-it-"));
    try {
      const script = text.split(/\s+/);
      const parts: Int16Array[] = [new Int16Array(Math.round(0.3 * SR))];
      const ref: { start: number; end: number }[] = [];
      let pos = parts[0]!.length;
      script.forEach((w, i) => {
        execFileSync("say", ["-v", voice, "-o", path.join(dir, "w.aiff"), "--", w]);
        const a = trim(pcm(path.join(dir, "w.aiff")));
        const gap = new Int16Array(Math.round((GAPS[i % GAPS.length]! / 1000) * SR));
        ref.push({ start: pos / SR, end: (pos + a.length) / SR });
        parts.push(a, gap);
        pos += a.length + gap.length;
      });
      const all = new Int16Array(pos);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      const file = path.join(dir, "clip.wav");
      writeFileSync(file, wav(all));

      const r = await alignChunk({ runChild, modelPath: MODEL }, { audioPath: file, durationS: pos / SR, lang, script });
      expect(r.timings_kind).toBe("aligned");
      expect(r.words.map((w) => w.word)).toEqual(script);
      const errs = r.words.map((w, i) => {
        const lo = i === 0 ? 0 : ref[i - 1]!.end, hi = ref[i]!.start;
        return w.startS < lo ? lo - w.startS : w.startS > hi ? w.startS - hi : 0;
      });
      errs.sort((a, b) => a - b);
      expect(errs[Math.floor(errs.length / 2)]!).toBeLessThan(0.1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
