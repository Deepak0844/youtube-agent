// Beat marks for cartoon scenes (port of cartoon-shorts core.js T(), "L" lines -> "B" beats). Seconds everywhere.
//   2.5 | B5 (beat 5 starts) | B5e (ends) | B5%60 (60% in) | B5+.3 / B5-.3 | scene id | <id>e (ends) | <id>+.4 | S2 (third scene)
// Inside a long-video chapter the host re-bases the beats so B0 is that chapter's first beat.
export type ToonBeat = { startS: number; endS: number; cap: string | null };
export type ToonSceneSpan = { id: string; startS: number; endS: number };
export type ToonTimeline = { beats: readonly ToonBeat[]; scenes: readonly ToonSceneSpan[] };

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function resolveMark(mark: string | number, tl: ToonTimeline): number {
  if (typeof mark === "number") {
    if (!Number.isFinite(mark)) throw new Error(`bad time ${mark}`);
    return mark;
  }
  const s = String(mark).trim();
  let m = /^B(\d+)(e|%[\d.]+)?([+-][\d.]+)?$/.exec(s);
  if (m) {
    const b = tl.beats[Number(m[1])];
    if (!b) throw new Error(`no beat ${s.replace(/^(B\d+).*$/, "$1")} (beats: ${tl.beats.length})`);
    const frac = m[2] === "e" ? 1 : m[2] ? parseFloat(m[2].slice(1)) / 100 : 0;
    if (Number.isNaN(frac)) throw new Error(`bad time ${s}`);
    return b.startS + (b.endS - b.startS) * frac + (Number(m[3]) || 0);
  }
  m = /^S(\d+)([+-][\d.]+)?$/.exec(s);
  if (m) {
    const sc = tl.scenes[Number(m[1])];
    if (!sc) throw new Error(`no scene ${s.replace(/^(S\d+).*$/, "$1")}`);
    return sc.startS + (Number(m[2]) || 0);
  }
  m = /^([a-z][a-z0-9_]*)([+-][\d.]+)?$/.exec(s);
  if (m) {
    const off = Number(m[2]) || 0;
    const byId = (id: string) => tl.scenes.find((x) => x.id === id);
    const whole = byId(m[1]!);
    if (whole) return whole.startS + off;
    if (m[1]!.endsWith("e")) {
      const base = byId(m[1]!.slice(0, -1));
      if (base) return base.endS + off;
    }
    throw new Error(`bad time ${s}`);
  }
  if (NUM.test(s)) return parseFloat(s);
  throw new Error(`bad time ${s}`);
}

/** The refusal text for a mark that would not resolve, or null when it is fine. */
export function markProblem(mark: string, tl: ToonTimeline): string | null {
  try {
    resolveMark(mark, tl);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
