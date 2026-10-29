import { describe, expect, it } from "vitest";
import { noteFrequency, synthChord } from "@/server/core/chords";

describe("chords", () => {
  it("a4_is_440_and_octave_doubles", () => {
    expect(noteFrequency("A4")).toBe(440);
    expect(noteFrequency("A5")).toBeCloseTo(880, 9);
    expect(noteFrequency("C4")).toBeCloseTo(261.6256, 3);
    expect(noteFrequency("C#4")).toBeCloseTo(277.1826, 3);
    expect(noteFrequency("Db4")).toBeCloseTo(noteFrequency("C#4"), 9);
  });
  it("invalid_note_names_throw", () => {
    for (const bad of ["H4", "C", "C#", "A44", "", "c4", "E#4x"]) expect(() => noteFrequency(bad)).toThrow();
    expect(() => synthChord([])).toThrow();
  });
  it("chord_bytes_identical_across_runs", () => {
    const a = synthChord(["C4", "E4", "G4"], { seconds: 0.5 });
    const b = synthChord(["C4", "E4", "G4"], { seconds: 0.5 });
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 4).toString()).toBe("RIFF");
    expect(a.length).toBe(44 + 22050 * 2);
    expect(synthChord(["C4", "E4"], { seconds: 0.5 }).equals(a)).toBe(false);
  });
});
