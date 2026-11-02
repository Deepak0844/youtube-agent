// Display-only rows for the script gate: beat name, voice line, on-screen action. Old beats may lack visual.
export interface BeatRow {
  name: string;
  line: string;
  action: string;
}

export function buildBeatRows(beats: unknown[]): BeatRow[] {
  return beats.map((raw, i) => {
    const b = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    return { name: s(b.id) || `beat-${i + 1}`, line: s(b.text), action: s(b.visual) };
  });
}
