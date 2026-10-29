import { z } from "zod";

// Pure rules for uploaded assets (Doc 13 4-6). No IO. Uploads are untrusted: names are metadata, never paths, and
// nothing is stored without a rights attestation.

export const RIGHTS_TEXT = "I have the rights to use this" as const;

export const ASSET_LIMIT_DEFAULTS = {
  maxImageBytes: 25 * 1024 * 1024,
  maxAudioBytes: 200 * 1024 * 1024,
  maxPixels: 50_000_000,
  maxBatchFiles: 100,
  totalBytesCap: 5 * 1024 * 1024 * 1024,
  maxAudioSeconds: 60 * 60,
} as const;

export const attestationSchema = z
  .object({
    at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "attestation time must be a date"),
    text: z.literal(RIGHTS_TEXT),
    consent_likeness: z.boolean().optional(),
    consent_voice: z.boolean().optional(),
  })
  .strict();

export const rightsSchema = z.object({ attestations: z.array(attestationSchema) }).strict();

/**
 * What the browser sends in the x-rights header. Strict: a caller-supplied `at` is refused, the server stamps the time.
 * `contains_person` and `voice_clone` are explicit answers (not guessed from tags): an image with a person, or a voice
 * recording used for cloning, needs the matching consent.
 */
export const rightsRequestSchema = z
  .object({
    text: z.literal(RIGHTS_TEXT),
    contains_person: z.boolean(),
    voice_clone: z.boolean(),
    consent_likeness: z.boolean().optional(),
    consent_voice: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(60)).max(50).default([]),
    caption: z.string().max(500).nullable().default(null),
    keep: z.boolean().default(false),
  })
  .strict();
export type RightsRequest = z.infer<typeof rightsRequestSchema>;

export type Attestation = z.infer<typeof attestationSchema>;

/** The attestation record: the time is the server's clock at the moment of upload. */
export function stampAttestation(r: RightsRequest, now: Date): Attestation {
  return { at: now.toISOString(), text: r.text, ...(r.consent_likeness !== undefined && { consent_likeness: r.consent_likeness }), ...(r.consent_voice !== undefined && { consent_voice: r.consent_voice }) };
}
export type Rights = z.infer<typeof rightsSchema>;

export type RightsRefusal = "no_attestation" | "likeness_consent_missing" | "voice_consent_missing";

/** Tags that mean "an identifiable person is in this photo". */
const PERSON_TAGS = new Set(["person", "people", "portrait", "face"]);
export const isPersonTagged = (tags: readonly string[]): boolean => tags.some((t) => PERSON_TAGS.has(t.trim().toLowerCase()));

export function checkRights(
  rights: Rights,
  ctx: { kind: "image" | "audio"; tags: readonly string[]; containsPerson?: boolean; voiceCloneReference?: boolean },
): { ok: true } | { ok: false; reason: RightsRefusal } {
  if (rights.attestations.length === 0) return { ok: false, reason: "no_attestation" };
  if (ctx.voiceCloneReference && !rights.attestations.some((a) => a.consent_voice === true)) return { ok: false, reason: "voice_consent_missing" };
  if (ctx.kind === "image" && (ctx.containsPerson === true || isPersonTagged(ctx.tags)) && !rights.attestations.some((a) => a.consent_likeness === true)) {
    return { ok: false, reason: "likeness_consent_missing" };
  }
  return { ok: true };
}

export const refusalMessage = (r: RightsRefusal): string =>
  r === "no_attestation"
    ? "Confirm that you have the rights to use this file."
    : r === "voice_consent_missing"
      ? "A voice recording used for cloning needs the speaker's consent."
      : "A photo of a person needs that person's consent.";

/** Duplicate merge (Doc 13 4): Keep wins, tags are the union, every attestation is kept, deletion is cancelled. */
export function mergeDuplicate(
  existing: { keep: boolean; tags: readonly string[]; rights: Rights },
  incoming: { keep: boolean; tags: readonly string[]; rights: Rights },
): { keep: boolean; tags: string[]; rights: Rights } {
  return {
    keep: existing.keep || incoming.keep,
    tags: [...new Set([...existing.tags, ...incoming.tags])],
    rights: { attestations: [...existing.rights.attestations, ...incoming.rights.attestations] },
  };
}

/**
 * A file name is display metadata only. Strips control characters (NUL included) and any folder part, collapses
 * ".." so it cannot read as a path, and caps the length. The result is never used to build a path; storage uses ids.
 */
export function cleanOriginalName(name: string): string {
  // Control characters and bidi overrides/isolates (they can make a name read backwards, e.g. "gnp.exe").
  const noCtl = name.replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const base = noCtl.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/\.{2,}/g, ".").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned === "" ? "untitled" : cleaned;
}

export interface AssetLimits {
  maxImageBytes: number;
  maxAudioBytes: number;
  maxPixels: number;
  maxBatchFiles: number;
  totalBytesCap: number;
}

export type LimitRefusal = "too_big" | "too_many_files" | "storage_full";

/** Byte and count limits the web process enforces while streaming (it never parses image headers). `maxBytes` is the cap for this file's kind. */
export function checkLimits(
  a: { bytes: number; batchFiles: number; storedBytes: number },
  l: { maxBytes: number; maxBatchFiles: number; totalBytesCap: number },
): { ok: true } | { ok: false; reason: LimitRefusal } {
  if (a.bytes <= 0 || a.bytes > l.maxBytes) return { ok: false, reason: "too_big" };
  if (a.batchFiles > l.maxBatchFiles) return { ok: false, reason: "too_many_files" };
  if (a.storedBytes + a.bytes > l.totalBytesCap) return { ok: false, reason: "storage_full" };
  return { ok: true };
}

/** What holds the stored bytes. Keep and trash come from assets; pins and stuck videos stay 0 until Phase 5 supplies them. */
export interface StorageHolders {
  keep: number;
  seriesPins: number;
  stuckVideos: number;
  trash: number;
}

const HOLDER_LABELS: Array<[keyof StorageHolders, string]> = [
  ["keep", "files marked Keep"],
  ["seriesPins", "series pins"],
  ["stuckVideos", "stuck videos"],
  ["trash", "the trash"],
];

/** Plain refusal for a full store, naming what holds the space so the owner knows what to free. */
export function storageFullMessage(h: StorageHolders): string {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const parts = HOLDER_LABELS.filter(([k]) => h[k] > 0).map(([k, label]) => `${label} (${gb(h[k])})`);
  return `Storage is full. ${parts.length ? `The space is held by ${parts.join(", ")}. Free some of it and try again.` : "Delete files you no longer need and try again."}`;
}
