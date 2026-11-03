// Short-video beat roles (hook, setup, quiz, reveal, twist, loop): the order check, the per-role scene guidance and the
// spoken-time estimate. Pure: no IO. Free-form ids (payoff, trap, teach...) are allowed anywhere between.

const RANK: Record<string, number> = { hook: 0, setup: 1, quiz: 2, reveal: 3, twist: 4, loop: 5 };
export type BeatRole = "hook" | "setup" | "quiz" | "reveal" | "twist" | "loop";

/** The role of a beat id ("reveal", "reveal-2", "reveal_3" are all reveal), or null for a free-form id. */
export function roleOf(id: string): BeatRole | null {
  const base = id.replace(/[-_]?\d+$/, "");
  return Object.hasOwn(RANK, base) ? (base as BeatRole) : null;
}

/** Plain problems for the Draft retry; empty = fine. Run only on new scene_kit shorts, never on stored scripts. */
export function checkBeatRoles(ids: readonly string[]): string[] {
  const out: string[] = [];
  if (ids[0] !== "hook") out.push("the first beat id must be 'hook'");
  if (ids[ids.length - 1] !== "loop") out.push("the last beat id must be 'loop'");
  if (!ids.some((i) => roleOf(i) === "reveal")) out.push("there must be at least one 'reveal' beat");
  let top = -1;
  for (const id of ids) {
    const r = roleOf(id);
    if (r === null) continue;
    if (RANK[r]! < top) {
      out.push(`beat '${id}' is out of order (use hook, setup, quiz, reveal, twist, loop in that order)`);
      break;
    }
    top = RANK[r]!;
  }
  return out;
}

/** One line of scene guidance per role, injected into the per-beat scene pick. */
export const ROLE_GUIDANCE: Record<BeatRole, string> = {
  hook: "Role hook: a bold title or hook scene with the payoff already visible at frame 0.",
  setup: "Role setup: a familiar, recognisable object scene.",
  quiz: "Role quiz: a pause_card that makes the viewer guess.",
  reveal: "Role reveal: the most animated kind available (svg_diagram, algo_cells, network, chart); it holds longest.",
  twist: "Role twist: a scene kind different from the previous beat's kind.",
  loop: "Role loop: visually match the hook scene (same kind and palette as scene 1) or use a pause_card or title card, so the end flows back into the start.",
};

export function roleGuidance(id: string): string {
  const r = roleOf(id);
  return r ? ROLE_GUIDANCE[r] : "";
}

export const WORDS_PER_SEC = 2.7;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Estimated start/end second of each beat from its words at 2.7 words/sec; a beat's end has slack up to the next beat's start. */
export function estimateBeatTimes(texts: readonly string[]): Array<{ est_start: number; est_end: number }> {
  let at = 0;
  const starts = texts.map((t) => {
    const s = at;
    at += t.split(/\s+/).filter(Boolean).length / WORDS_PER_SEC;
    return s;
  });
  return starts.map((s, i) => ({ est_start: r1(s), est_end: r1(i + 1 < starts.length ? starts[i + 1]! : at) }));
}

/** Beats with est_start/est_end added when every beat carries text; other fields untouched. */
export function withTimeEstimates<T extends object>(beats: readonly T[]): T[] {
  const text = (b: T): unknown => (b as { text?: unknown }).text;
  if (beats.length === 0 || !beats.every((b) => typeof text(b) === "string")) return [...beats];
  const t = estimateBeatTimes(beats.map((b) => text(b) as string));
  return beats.map((b, i) => ({ ...b, ...t[i]! }));
}
