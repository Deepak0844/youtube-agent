import { z } from "zod";
import { CAPTION_STYLE_IDS, STYLE_IDS } from "../../../remotion/kit/presets";
import { cleanText } from "@/server/core/ideas";
import { LANGS } from "@/server/core/lang";

// Series rules. Pure: no IO. Everything typed or pasted is untrusted text: cleaned and length-limited here.

export const SERIES_LIMITS = { titleMin: 3, title: 80, premise: 1000, partTitle: 200, oneLine: 400, parts: 50, capUsdMax: 1_000_000 } as const;
export const SERIES_FORMATS = ["short", "long", "mixed"] as const;

/** Only keys the app already knows: the voice id the voice stage takes, the scene-kit style and the caption style. */
export const seriesSettingsSchema = z.strictObject({
  voice: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use letters, numbers, - and _ for the voice id.").optional(),
  style: z.enum(STYLE_IDS, "Pick one of the listed styles.").optional(),
  captionStyle: z.enum(CAPTION_STYLE_IDS, "Pick a listed caption style.").optional(),
});
export type SeriesSettings = z.infer<typeof seriesSettingsSchema>;

const newSeriesSchema = z.object({
  title: z.string().min(SERIES_LIMITS.titleMin, `Give the series a title of ${SERIES_LIMITS.titleMin} to ${SERIES_LIMITS.title} characters.`).max(SERIES_LIMITS.title, `Give the series a title of ${SERIES_LIMITS.titleMin} to ${SERIES_LIMITS.title} characters.`),
  premise: z.string().max(SERIES_LIMITS.premise),
  channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Pick a channel from the list.").nullable(),
  language: z.enum(LANGS, "Pick a narration language."),
  formats: z.enum(SERIES_FORMATS, "Pick the formats the series allows."),
  capMicroUsd: z.number().int().min(0).max(SERIES_LIMITS.capUsdMax * 1_000_000).nullable(),
  settings: seriesSettingsSchema,
});
export type NewSeriesInput = z.infer<typeof newSeriesSchema>;

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseSeriesForm(form: FormData): Parsed<NewSeriesInput> {
  const g = (k: string): string => (typeof form.get(k) === "string" ? (form.get(k) as string) : "");
  const rawCap = g("capUsd").trim();
  let cap: number | null = null;
  if (rawCap !== "") {
    const usd = Number(rawCap);
    if (!Number.isFinite(usd) || usd < 0 || usd > SERIES_LIMITS.capUsdMax) return { ok: false, message: "The spend cap must be a dollar amount of 0 or more, or empty for no limit." };
    cap = Math.round(usd * 1_000_000);
  }
  const settings: Record<string, string> = {};
  for (const k of ["voice", "style", "captionStyle"]) if (g(k).trim()) settings[k] = g(k).trim();
  const r = newSeriesSchema.safeParse({
    title: cleanText(g("title"), 1000),
    premise: cleanText(g("premise"), SERIES_LIMITS.premise),
    channelId: g("channel").trim() || null,
    language: g("language") || "en",
    formats: g("formats") || "short",
    capMicroUsd: cap,
    settings,
  });
  return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues[0]?.message ?? "Check the series details." };
}

export interface EpisodeInput {
  title: string;
  oneLine: string;
}

/** One episode per line: "Title - one line" (or "|"). Leading numbers and bullets are ignored. */
export function parseEpisodeList(text: string): Parsed<EpisodeInput[]> {
  const out: EpisodeInput[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:\d{1,3}[.)]|[-*•])\s*/, "");
    const cut = line.search(/\s[|–—-]\s/);
    const title = cleanText(cut < 0 ? line : line.slice(0, cut), SERIES_LIMITS.partTitle);
    if (!title) continue;
    out.push({ title, oneLine: cut < 0 ? "" : cleanText(line.slice(cut + 3), SERIES_LIMITS.oneLine) });
  }
  if (out.length === 0) return { ok: false, message: "Type one episode per line, like: Arrays - How memory is laid out." };
  if (out.length > SERIES_LIMITS.parts) return { ok: false, message: `A series can plan up to ${SERIES_LIMITS.parts} parts at a time.` };
  return { ok: true, value: out };
}

/** Dropped parts keep their number, so numbers are never reused. */
export const nextPartNo = (partNos: readonly number[]): number => partNos.reduce((m, n) => Math.max(m, n), 0) + 1;

/** `planned` = the part numbers still planned. The planned neighbour whose number to swap with, or null at the end. */
export function swapTarget(planned: readonly number[], partNo: number, dir: "up" | "down"): number | null {
  const sorted = [...planned].sort((a, b) => a - b);
  const at = sorted.indexOf(partNo);
  if (at < 0) return null;
  return sorted[dir === "up" ? at - 1 : at + 1] ?? null;
}

export type CapState = "no_limit" | "ok" | "near" | "over";
export function capStatus(spentMicroUsd: number, capMicroUsd: number | null): { state: CapState; pct: number } {
  if (capMicroUsd === null) return { state: "no_limit", pct: 0 };
  if (capMicroUsd === 0 || spentMicroUsd >= capMicroUsd) return { state: "over", pct: 100 };
  const pct = Math.floor((spentMicroUsd / capMicroUsd) * 100);
  return { state: pct >= 80 ? "near" : "ok", pct };
}
