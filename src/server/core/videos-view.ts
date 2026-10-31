import { z } from "zod";
import { LANGS } from "@/server/core/lang";

// Pure: the Library's filters and words, and the New form's input. No IO.

export const PAGE_SIZE = 25;
export const STATUSES = ["active", "waiting", "done", "failed", "cancelled"] as const;
export const FORMATS = ["short", "long"] as const;
export const KINDS = ["scene_kit", "tsx", "collage", "ai"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_WORDS: Record<Status, { label: string; tone: "positive" | "negative" | "warning" | "neutral" }> = {
  active: { label: "Working", tone: "neutral" },
  waiting: { label: "Needs you", tone: "warning" },
  done: { label: "Finished", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};
export const FORMAT_WORDS = { short: "Short", long: "Long" } as const;
export const KIND_WORDS = { scene_kit: "Scene kit", tsx: "TSX", collage: "Collage", ai: "AI" } as const;
export const LANGUAGE_WORDS = { en: "English", hi: "Hindi", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam" } as const;
/** Order shown in the New form. */
export const LANGUAGE_ORDER = ["en", "hi", "ta", "te", "kn", "ml"] as const;

export interface LibraryFilter {
  format?: (typeof FORMATS)[number];
  status?: Status;
  language?: (typeof LANGS)[number];
  kind?: (typeof KINDS)[number];
  page: number;
}

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const pick = <T extends string>(list: readonly T[], v: unknown): T | undefined => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined);

/** Anything unknown is ignored (never an error): a hand-edited address just shows the unfiltered list. */
export function parseLibraryQuery(raw: Record<string, unknown>): LibraryFilter {
  const n = Number(first(raw.page));
  return {
    format: pick(FORMATS, first(raw.format)),
    status: pick(STATUSES, first(raw.status)),
    language: pick(LANGS, first(raw.language)),
    kind: pick(KINDS, first(raw.kind)),
    page: Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1,
  };
}

export function libraryHref(f: LibraryFilter, over: Partial<Record<keyof LibraryFilter, string | number | undefined>> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...over })) if (v !== undefined && !(k === "page" && Number(v) === 1)) p.set(k, String(v));
  const s = p.toString();
  return s ? `/videos?${s}` : "/videos";
}

/** "3 min ago" style, coarse on purpose. */
export function ageLabel(then: Date, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export const newVideoSchema = z.object({
  topic: z.string().trim().min(1, "Enter a topic.").max(200, "Keep the topic to 200 characters or fewer."),
  language: z.enum(LANGS, "Pick a narration language."),
  kind: z.literal("scene_kit", "Only the scene kit is available for now."),
  format: z.literal("short", "Only Shorts are available for now."),
  notes: z.string().trim().max(2000, "Keep the notes to 2000 characters or fewer.").optional(),
});
export type NewVideoInput = z.infer<typeof newVideoSchema>;

export function parseNewVideoForm(form: FormData): { ok: true; value: NewVideoInput } | { ok: false; message: string } {
  const g = (k: string) => (typeof form.get(k) === "string" ? (form.get(k) as string) : undefined);
  const r = newVideoSchema.safeParse({ topic: g("topic"), language: g("language"), kind: g("kind") ?? "scene_kit", format: g("format") ?? "short", notes: g("notes") || undefined });
  return r.success ? { ok: true, value: r.data } : { ok: false, message: r.error.issues[0]?.message ?? "Check the form and try again." };
}
