// Pure rules for the publish approval (Doc 02 4.4, ADR 0004). No IO. Everything fails closed: an unknown, missing or
// oddly typed value is a refusal, never a default. Public is off unless the global kill switch is exactly `true`.

export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const MIN_PUBLISH_LEAD_MS = 60 * 60 * 1000;

/** Upload limits until Phase 5 reads the real channel quota. 6 inserts x 1600 units stays under YouTube's 10 000 a day. */
export const UPLOAD_CAPS = Object.freeze({ maxPerDay: 6, minSpacingMs: 0, dailyQuotaUnits: 10_000, costUnits: 1_600 });

export function visibilityProblem(v: unknown): string | null {
  return typeof v === "string" && (VISIBILITIES as readonly string[]).includes(v) ? null : "visibility must be private, unlisted or public";
}

// Date and time with an explicit zone. No lenient forms: a date that needs guessing is a date somebody crafted.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
const BAD_DATE = "publish_at must be a date and time like 2026-11-02T10:00:00Z, with its time zone";

function parts(s: string): { ms: number } | null {
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return null;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(); // days in that month
  if (d < 1 || d > dim) return null;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { ms } : null;
}

/** null (publish now) or a well-formed ISO-8601 instant with a zone. */
export function publishAtProblem(v: unknown): string | null {
  if (v === null) return null;
  return typeof v === "string" && parts(v) !== null ? null : BAD_DATE;
}

/** A scheduled time must be at least 60 minutes after `nowMs` (the DATABASE clock, passed in). Compares instants. */
export function publishLeadProblem(publishAt: string | null, nowMs: number): string | null {
  if (publishAt === null) return null;
  const p = typeof publishAt === "string" ? parts(publishAt) : null;
  if (!p) return BAD_DATE;
  return p.ms - nowMs >= MIN_PUBLISH_LEAD_MS ? null : "publish_at must be at least 60 minutes from now";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The metadata fields the publish hash and the upload rely on. */
export function metadataProblem(body: unknown): string | null {
  if (!isObj(body)) return "the title and description are missing or unreadable";
  return visibilityProblem(body.visibility) ?? publishAtProblem(body.publish_at ?? null);
}

export interface PublishPolicyInput {
  visibility: unknown;
  publishAt: unknown;
  nowMs: number;
  /** Stored value of policy.allow_public: only boolean true opens public. */
  allowPublic: unknown;
  /** Stored value of policy.require_evidence: only boolean false switches the check off. */
  requireEvidence: unknown;
  evidenceApproved: boolean;
  videoApproved: boolean;
  /** "approve": the 60-minute lead applies. "upload": the job runs later, so only "not already in the past" applies. */
  phase?: "approve" | "upload";
}

/** The first reason a publish approval must be refused, in words the owner can read, or null. */
export function publishPolicyProblem(i: PublishPolicyInput): string | null {
  const v = visibilityProblem(i.visibility);
  if (v) return v;
  const at = publishAtProblem(i.publishAt);
  if (at) return at;
  if (i.visibility === "public" && i.allowPublic !== true) return "public publishing is switched off in settings (allow public); choose private or unlisted";
  if (!i.videoApproved) return "approve the video first";
  if (i.requireEvidence !== false && !i.evidenceApproved) return "the evidence must be signed off before publishing";
  const at2 = (i.publishAt ?? null) as string | null;
  if (i.phase === "upload") return at2 !== null && parts(at2)!.ms <= i.nowMs ? "the scheduled publish time has already passed; approve again with a new time" : null;
  return publishLeadProblem(at2, i.nowMs);
}
