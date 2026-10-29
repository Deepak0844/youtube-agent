// Zero-cost chords: additive synthesis, equal temperament, A4 = 440 Hz. Pure arithmetic, so the same input gives the same bytes.

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE = /^([A-G])([#b]?)(-?\d)$/;

/** Frequency in Hz of a note name such as "C#4" or "Bb3". Anything else throws. */
export function noteFrequency(note: string): number {
  const m = NOTE.exec(note);
  if (!m) throw new Error(`invalid note name: ${JSON.stringify(note)}`);
  const midi = 12 * (Number(m[3]) + 1) + SEMITONE[m[1]!]! + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

const PARTIALS = [1, 0.5, 0.25]; // amplitude of harmonics 1, 2, 3
const EDGE_S = 0.02; // linear fade in and out, so the clip has no click

/** Mono 16-bit PCM WAV of the notes played together. */
export function synthChord(notes: string[], opts: { seconds?: number; sampleRate?: 44100 } = {}): Buffer {
  if (notes.length === 0) throw new Error("a chord needs at least one note");
  const rate = opts.sampleRate ?? 44100;
  const seconds = opts.seconds ?? 2;
  const freqs = notes.map(noteFrequency);
  const n = Math.round(seconds * rate);
  const scale = 0.8 / (notes.length * PARTIALS.reduce((a, b) => a + b, 0));
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const f of freqs) PARTIALS.forEach((a, h) => (v += a * Math.sin(2 * Math.PI * f * (h + 1) * t)));
    const env = Math.min(1, t / EDGE_S, (seconds - t) / EDGE_S);
    out.writeInt16LE(Math.round(Math.max(0, env) * v * scale * 32767), 44 + i * 2);
  }
  return out;
}
