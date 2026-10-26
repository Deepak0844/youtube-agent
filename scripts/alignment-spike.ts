/**
 * Phase 0 alignment spike: do whisper.cpp word timings hold up on short narration clips?
 *
 * Reference timings are exact BY CONSTRUCTION: each script word is synthesised on its own,
 * edge-silence is trimmed, and the words are laid on a 16 kHz timeline with known gaps.
 * Caveat: isolated words have no sentence prosody, so this tests timing accuracy, not
 * how whisper copes with flowing speech. A second "natural" pass (whole text in one go)
 * reports only word coverage and where the last word ends, because it has no per-word truth.
 *
 *   tsx scripts/alignment-spike.ts --model <ggml.bin> [--lang en,hi] [--out dir] [--prompt]
 * Needs: whisper-cli, ffmpeg, macOS `say`, espeak-ng (Malayalam has no macOS voice).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Lang { code: string; tts: "say" | "espeak"; voice: string; text: string }
const LANGS: Lang[] = [
  { code: "en", tts: "say", voice: "Samantha", text: "Hello friends today we will talk about the moon The moon is the only natural satellite of the Earth It is about four hundred thousand kilometers away from us At night it shines in the sky and it also pulls the ocean waves" },
  { code: "hi", tts: "say", voice: "Lekha", text: "नमस्ते दोस्तों आज हम चाँद के बारे में बात करेंगे चाँद पृथ्वी का एकमात्र प्राकृतिक उपग्रह है यह हमसे लगभग चार लाख किलोमीटर दूर है रात को यह आसमान में चमकता है और समुद्र की लहरों को भी प्रभावित करता है" },
  { code: "ta", tts: "say", voice: "Vani", text: "வணக்கம் நண்பர்களே இன்று நாம் நிலவைப் பற்றி பேசப்போகிறோம் நிலவு பூமியின் ஒரே இயற்கை துணைக்கோள் ஆகும் இது நம்மிலிருந்து சுமார் நான்கு லட்சம் கிலோமீட்டர் தொலைவில் உள்ளது இரவில் வானத்தில் ஒளிர்கிறது கடல் அலைகளையும் பாதிக்கிறது" },
  { code: "te", tts: "say", voice: "Geeta", text: "నమస్కారం మిత్రులారా ఈ రోజు మనం చంద్రుని గురించి మాట్లాడుకుందాం చంద్రుడు భూమికి ఉన్న ఒకే ఒక సహజ ఉపగ్రహం ఇది మనకు సుమారు నాలుగు లక్షల కిలోమీటర్ల దూరంలో ఉంది రాత్రి ఆకాశంలో వెలుగుతుంది సముద్ర అలలను కూడా ప్రభావితం చేస్తుంది" },
  { code: "ml", tts: "espeak", voice: "ml", text: "നമസ്കാരം കൂട്ടുകാരേ ഇന്ന് നമ്മൾ ചന്ദ്രനെക്കുറിച്ച് സംസാരിക്കാം ചന്ദ്രൻ ഭൂമിയുടെ ഏക പ്രകൃതിദത്ത ഉപഗ്രഹമാണ് ഇത് നമ്മളിൽ നിന്ന് ഏകദേശം നാല് ലക്ഷം കിലോമീറ്റർ അകലെയാണ് രാത്രിയിൽ ആകാശത്ത് തിളങ്ങുന്നു കടലിലെ തിരമാലകളെയും സ്വാധീനിക്കുന്നു" },
  { code: "kn", tts: "say", voice: "Soumya", text: "ನಮಸ್ಕಾರ ಸ್ನೇಹಿತರೇ ಇಂದು ನಾವು ಚಂದ್ರನ ಬಗ್ಗೆ ಮಾತನಾಡೋಣ ಚಂದ್ರನು ಭೂಮಿಯ ಏಕೈಕ ನೈಸರ್ಗಿಕ ಉಪಗ್ರಹ ಇದು ನಮ್ಮಿಂದ ಸುಮಾರು ನಾಲ್ಕು ಲಕ್ಷ ಕಿಲೋಮೀಟರ್ ದೂರದಲ್ಲಿದೆ ರಾತ್ರಿ ಆಕಾಶದಲ್ಲಿ ಹೊಳೆಯುತ್ತದೆ ಸಮುದ್ರದ ಅಲೆಗಳ ಮೇಲೂ ಪ್ರಭಾವ ಬೀರುತ್ತದೆ" },
];

const SR = 16000;
const GAPS_MS = [90, 140, 200, 120, 260, 110]; // fixed cycle, so runs are repeatable
const LOW_P = 0.5; // a word is low confidence if its weakest token is below this

interface RefWord { text: string; start: number; end: number } // seconds
interface HypWord { text: string; start: number; end: number; minP: number }

const args = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const model = opt("model");
if (!model) throw new Error("--model <ggml-*.bin> is required");
const out = opt("out") ?? "/tmp/alignment-spike";
const only = opt("lang")?.split(",");
const usePrompt = args.includes("--prompt");
mkdirSync(out, { recursive: true });

function pcm(file: string): Int16Array {
  const buf = execFileSync("ffmpeg", ["-loglevel", "error", "-i", file, "-ar", String(SR), "-ac", "1", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1).slice();
}

function synth(l: Lang, text: string, file: string): Int16Array {
  if (l.tts === "say") {
    execFileSync("say", ["-v", l.voice, "-o", file + ".aiff", "--", text]);
    return pcm(file + ".aiff");
  }
  execFileSync("espeak-ng", ["-v", l.voice, "-w", file + ".wav", "--", text]);
  return pcm(file + ".wav");
}

/** Trim to where the signal rises above ~1% of full scale; this is the edge the reference uses. */
function trim(a: Int16Array): Int16Array {
  const th = 330;
  let s = 0, e = a.length - 1;
  while (s < e && Math.abs(a[s]!) < th) s++;
  while (e > s && Math.abs(a[e]!) < th) e--;
  return a.slice(s, e + 1);
}

function writeWav(file: string, a: Int16Array): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + a.length * 2, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(a.length * 2, 40);
  writeFileSync(file, Buffer.concat([h, Buffer.from(a.buffer, a.byteOffset, a.byteLength)]));
}

function buildClip(l: Lang): { wav: string; ref: RefWord[] } {
  const words = l.text.split(/\s+/);
  const parts: Int16Array[] = [];
  const ref: RefWord[] = [];
  let pos = Math.round(0.3 * SR);
  parts.push(new Int16Array(pos));
  words.forEach((w, i) => {
    const a = trim(synth(l, w, join(out, `${l.code}-w`)));
    ref.push({ text: w, start: pos / SR, end: (pos + a.length) / SR });
    const gap = Math.round(((GAPS_MS[i % GAPS_MS.length] ?? 100) / 1000) * SR);
    parts.push(a, new Int16Array(gap));
    pos += a.length + gap;
  });
  const all = new Int16Array(pos);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const wav = join(out, `${l.code}.wav`);
  writeWav(wav, all);
  writeFileSync(join(out, `${l.code}.ref.json`), JSON.stringify(ref, null, 1)); // for hand-checking against the wav
  return { wav, ref };
}

function whisper(wav: string, lang: string, tag: string, prompt?: string): HypWord[] {
  const base = join(out, tag);
  const a = ["-m", model!, "-l", lang, "-f", wav, "-ml", "1", "-sow", "-ojf", "-of", base, "-np"];
  if (prompt) a.push("--prompt", prompt);
  execFileSync("whisper-cli", a, { stdio: "ignore" });
  const j = JSON.parse(readFileSync(base + ".json", "utf8")) as {
    transcription: { text: string; offsets: { from: number; to: number }; tokens: { p: number; id: number }[] }[];
  };
  return j.transcription
    .filter((s) => s.text.trim() !== "")
    .map((s) => ({
      text: s.text.trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000,
      minP: Math.min(...s.tokens.filter((t) => t.id < 50257).map((t) => t.p), 1),
    }));
}

const norm = (s: string): string => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, "");
function lev(a: string, b: string): number {
  const p = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = p[0]!; p[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = p[j]!;
      p[j] = Math.min(p[j]! + 1, p[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return p[b.length]!;
}
const dist = (a: string, b: string): number => lev(norm(a), norm(b)) / Math.max(norm(a).length, norm(b).length, 1);

/**
 * Order-preserving match of recognised words to script words. Substitution is cheaper than
 * a miss + an extra word, so a misspelt or transliterated word still pairs (and is timed);
 * `exact` below says how many also had matching text.
 */
function align(ref: RefWord[], hyp: HypWord[]): [number, number][] {
  const n = ref.length, m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) d[i]![0] = i;
  for (let j = 1; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + dist(ref[i - 1]!.text, hyp[j - 1]!.text) * 0.6 + 0.4);
  }
  const pairs: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const c = dist(ref[i - 1]!.text, hyp[j - 1]!.text) * 0.6 + 0.4;
    if (d[i]![j] === d[i - 1]![j - 1]! + c) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--;
  }
  return pairs.reverse();
}

const q = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const ms = (x: number): string => (Number.isNaN(x) ? "n/a" : String(Math.round(x * 1000)));

console.log(`model=${model} prompt=${usePrompt}`);
console.log("lang words missed exact | centre err med/p95 ms | cut-outside-silence med/p95 ms | bad(cut >100ms outside silence or missed) | flagged-low-conf | flagged-among-bad | natural: words/expected last-end-err ms");
for (const l of LANGS.filter((x) => !only || only.includes(x.code))) {
  const { wav, ref } = buildClip(l);
  const hyp = whisper(wav, l.code, l.code, usePrompt ? l.text : undefined);
  // Timing is judged per script word against the recognised word that overlaps it most in time,
  // whatever text it carries (whisper may romanise Indic scripts, so text matching cannot gate timing).
  // Whisper word segments abut, so a word's start swallows the preceding gap; the boundary test copes with that.
  const overlap = (r: RefWord, h: HypWord): number => Math.min(r.end, h.end) - Math.max(r.start, h.start);
  const cErr: number[] = [], eErr: number[] = [];
  let missed = 0, flaggedBad = 0, bad = 0;
  const flagged = (h: HypWord): boolean => h.minP < LOW_P || h.end - h.start < 0.05;
  for (const [k, r] of ref.entries()) {
    let best: HypWord | undefined;
    for (const h of hyp) if (overlap(r, h) > 0 && (!best || overlap(r, h) > overlap(r, best))) best = h;
    if (!best) { missed++; bad++; continue; }
    const c = Math.abs((best.start + best.end) / 2 - (r.start + r.end) / 2);
    // Boundary test: whisper cuts words back to back, so a caption cut is right if it lands in the
    // real silence before this word (or on its onset for the first word).
    const lo = k ? ref[k - 1]!.end : r.start, hi = r.start;
    const b = Math.max(lo - best.start, best.start - hi, 0);
    cErr.push(c); eErr.push(b);
    if (b > 0.1) { bad++; if (flagged(best)) flaggedBad++; } // 100 ms is about 3 frames at 30 fps
  }
  const exact = align(ref, hyp).filter(([i, j]) => norm(ref[i]!.text) === norm(hyp[j]!.text)).length;
  const flaggedN = hyp.filter(flagged).length;

  // natural pass: whole text in one utterance; only the word count and the last word's end are checkable
  const nat = synth(l, l.text, join(out, `${l.code}-nat`));
  writeWav(join(out, `${l.code}-nat.wav`), nat);
  const natHyp = whisper(join(out, `${l.code}-nat.wav`), l.code, `${l.code}-nat`);
  const voicedEnd = (firstNonSilent(nat) + trim(nat).length) / SR;
  const lastErr = natHyp.length ? natHyp[natHyp.length - 1]!.end - voicedEnd : NaN;

  console.log(
    [l.code, ref.length, missed, `${Math.round((exact / ref.length) * 100)}%`,
      `| ${ms(q(cErr, 0.5))}/${ms(q(cErr, 0.95))} | ${ms(q(eErr, 0.5))}/${ms(q(eErr, 0.95))} |`,
      `${bad}/${ref.length}`, flaggedN, `${flaggedBad}/${bad - missed}`, `| ${natHyp.length}/${ref.length} ${ms(lastErr)}`].join(" "),
  );
}

function firstNonSilent(a: Int16Array): number {
  let s = 0;
  while (s < a.length && Math.abs(a[s]!) < 330) s++;
  return s;
}
