// Pure piano helpers (no Remotion imports). Notes are sharps only ("C4", "F#3"), octave 0-8.
const SEMITONE: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
const NOTE_RE = /^([A-G]#?)([0-8])$/;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** "C4" -> 60. Null when the name is not a valid note. */
export function noteMidi(note: string): number | null {
  const m = NOTE_RE.exec(note);
  return m ? 12 * (Number(m[2]) + 1) + SEMITONE[m[1]!]! : null;
}

export const isBlackKey = (midi: number) => BLACK.has(midi % 12);

/** All midi numbers from `from` to `to` inclusive, with white-key index (black keys sit after the white key below). */
export function pianoKeys(from: string, to: string): { midi: number; black: boolean; whiteIndex: number }[] {
  const lo = noteMidi(from);
  const hi = noteMidi(to);
  if (lo === null || hi === null || hi < lo) return [];
  const keys: { midi: number; black: boolean; whiteIndex: number }[] = [];
  let whites = 0;
  for (let m = lo; m <= hi; m++) {
    const black = isBlackKey(m);
    keys.push({ midi: m, black, whiteIndex: black ? whites - 1 : whites });
    if (!black) whites++;
  }
  return keys;
}
