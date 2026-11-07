// Idea backlog rules. Pure: no IO. Idea text is untrusted data (typed now, written by the web researcher later):
// it is cleaned and length-limited here, and never reaches a prompt or a shell from this module.

const STOP = new Set("a an the of to and or for in on how why what is are with your you it its this that does do can".split(" "));

export const IDEA_LIMITS = { topicMin: 8, topic: 200, hook: 300, why: 400, sources: 4, source: 300, scoreMin: 2, scoreMax: 10 } as const;

/** Ported from the old app: lowercase words, stop words and one-letter words dropped. */
export function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 1));
}

/** Ported from the old app: Jaccard >= 0.5, or the smaller topic is 80% inside the other. */
export function similar(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.5 || inter / Math.min(ta.size, tb.size) >= 0.8;
}

export function findSimilar(topic: string, known: readonly string[]): string | null {
  return known.find((k) => similar(topic, k)) ?? null;
}

/** Control, zero-width and direction-override characters out, runs of white space to one space, cut to `max`. */
export function cleanText(s: string, max: number): string {
  return s
    .replace(/[\t\n\r]+/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export interface IdeaInput {
  topic: string;
  hook: string;
  why: string;
  sources: string[];
  score: number;
}

const SOURCE = /^https:\/\/[^\s]+$/;

export function parseIdeaForm(form: FormData): { ok: true; value: IdeaInput } | { ok: false; message: string } {
  const g = (k: string): string => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const topic = cleanText(g("topic"), 1000);
  if (topic.length < IDEA_LIMITS.topicMin || topic.length > IDEA_LIMITS.topic) return { ok: false, message: `Describe the idea in ${IDEA_LIMITS.topicMin} to ${IDEA_LIMITS.topic} characters.` };
  const raw = g("score").trim();
  const score = raw === "" ? 6 : Number(raw);
  if (!Number.isFinite(score) || score < IDEA_LIMITS.scoreMin || score > IDEA_LIMITS.scoreMax) return { ok: false, message: "The score must be between 2 and 10." };
  // One source per line; the line breaks must be split before cleanText flattens them.
  const sources = g("sources")
    .split(/\r?\n/)
    .map((l) => cleanText(l, IDEA_LIMITS.source))
    .filter((l) => SOURCE.test(l))
    .slice(0, IDEA_LIMITS.sources);
  return { ok: true, value: { topic, hook: cleanText(g("hook"), IDEA_LIMITS.hook), why: cleanText(g("why"), IDEA_LIMITS.why), sources, score: Math.round(score * 10) / 10 } };
}
