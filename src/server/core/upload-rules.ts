// Pure rules for the one-shot YouTube upload transition. No IO. An upload is public and irreversible, so every
// check fails closed and every numeric input is validated (RangeError) rather than coerced.

export type UploadCaps = { maxPerDay: number; minSpacingMs: number; dailyQuotaUnits: number; costUnits: number };

export type UploadRefusal = "approval_changed" | "file_changed" | "daily_cap" | "spacing" | "quota";

function nonNegInt(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative safe integer, got ${v}`);
}
function validDate(name: string, d: Date): void {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new RangeError(`${name} must be a valid Date`);
}

export function assertUploadCaps(caps: UploadCaps): void {
  nonNegInt("caps.maxPerDay", caps.maxPerDay);
  nonNegInt("caps.minSpacingMs", caps.minSpacingMs);
  nonNegInt("caps.dailyQuotaUnits", caps.dailyQuotaUnits);
  nonNegInt("caps.costUnits", caps.costUnits);
}

export function checkUploadPreconditions(args: {
  approvalHash: string;
  currentApprovalHash: string;
  fileSha: string;
  currentFileSha: string;
  caps: UploadCaps;
  uploadsToday: number;
  lastUploadAt: Date | null;
  quotaUsedToday: number;
  now: Date;
}): { ok: true } | { ok: false; reason: UploadRefusal } {
  assertUploadCaps(args.caps);
  nonNegInt("uploadsToday", args.uploadsToday);
  nonNegInt("quotaUsedToday", args.quotaUsedToday);
  validDate("now", args.now);
  if (args.lastUploadAt !== null) validDate("lastUploadAt", args.lastUploadAt);

  if (args.approvalHash !== args.currentApprovalHash) return { ok: false, reason: "approval_changed" };
  if (args.fileSha !== args.currentFileSha) return { ok: false, reason: "file_changed" };
  if (args.uploadsToday >= args.caps.maxPerDay) return { ok: false, reason: "daily_cap" };
  if (args.lastUploadAt !== null && args.now.getTime() - args.lastUploadAt.getTime() < args.caps.minSpacingMs) {
    return { ok: false, reason: "spacing" };
  }
  if (args.quotaUsedToday + args.caps.costUnits > args.caps.dailyQuotaUnits) return { ok: false, reason: "quota" };
  return { ok: true };
}

// True when the upload has made no progress for at least noProgressMs.
export function isStalled(lastProgressAt: Date, now: Date, noProgressMs: number): boolean {
  validDate("lastProgressAt", lastProgressAt);
  validDate("now", now);
  nonNegInt("noProgressMs", noProgressMs);
  return now.getTime() - lastProgressAt.getTime() >= noProgressMs;
}
