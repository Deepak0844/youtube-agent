import { z } from "zod";

// Pure rules for uploaded assets (Doc 13 4-6). No IO. Uploads are untrusted: names are metadata, never paths, and
// nothing is stored without a rights attestation.

export const RIGHTS_TEXT = "I have the rights to use this" as const;

export const ASSET_LIMIT_DEFAULTS = {
  maxImageBytes: 25 * 1024 * 1024,
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

export type Attestation = z.infer<typeof attestationSchema>;
export type Rights = z.infer<typeof rightsSchema>;

export type RightsRefusal = "no_attestation" | "likeness_consent_missing" | "voice_consent_missing";

/** Tags that mean "an identifiable person is in this photo". */
const PERSON_TAGS = new Set(["person", "people", "portrait", "face"]);
export const isPersonTagged = (tags: readonly string[]): boolean => tags.some((t) => PERSON_TAGS.has(t.trim().toLowerCase()));

export function checkRights(
  rights: Rights,
  ctx: { kind: "image" | "audio"; tags: readonly string[]; voiceCloneReference?: boolean },
): { ok: true } | { ok: false; reason: RightsRefusal } {
  if (rights.attestations.length === 0) return { ok: false, reason: "no_attestation" };
  if (ctx.voiceCloneReference && !rights.attestations.some((a) => a.consent_voice === true)) return { ok: false, reason: "voice_consent_missing" };
  if (ctx.kind === "image" && isPersonTagged(ctx.tags) && !rights.attestations.some((a) => a.consent_likeness === true)) {
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
  const noCtl = name.replace(/[\u0000-\u001f\u007f]/g, "");
  const base = noCtl.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/\.{2,}/g, ".").replace(/^\.+/, "").trim().slice(0, 200);
  return cleaned === "" ? "untitled" : cleaned;
}

export interface AssetLimits {
  maxImageBytes: number;
  maxPixels: number;
  maxBatchFiles: number;
  totalBytesCap: number;
}

export type LimitRefusal = "too_big" | "too_many_files" | "storage_full";

/** Byte and count limits the web process enforces while streaming (it never parses image headers). */
export function checkLimits(
  a: { bytes: number; batchFiles: number; storedBytes: number },
  l: Pick<AssetLimits, "maxImageBytes" | "maxBatchFiles" | "totalBytesCap">,
): { ok: true } | { ok: false; reason: LimitRefusal } {
  if (a.bytes <= 0 || a.bytes > l.maxImageBytes) return { ok: false, reason: "too_big" };
  if (a.batchFiles > l.maxBatchFiles) return { ok: false, reason: "too_many_files" };
  if (a.storedBytes + a.bytes > l.totalBytesCap) return { ok: false, reason: "storage_full" };
  return { ok: true };
}
