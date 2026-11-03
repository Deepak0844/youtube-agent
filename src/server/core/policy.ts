// Policy defaults in ONE place (Phase 5; the file reader is src/server/db/policy-file.ts). ops/policy.json, when it exists, overrides single fields; a missing file, bad JSON
// or a field of the wrong type falls back to the built-in value for that field.
// USED today: quotaBudget (clamped to 10,000) by reserveQuota and the per-channel upload caps. NOT used yet: defaultVisibility,
// maxUploadsPerDay and minHoursBetweenUploads (the channel columns carry their own defaults of 2 and 6), minScheduleLeadMinutes
// (publish-rules keeps its fixed 60 minutes), repliesPerDay and secondsBetweenReplies (no reply feature yet).
export interface Policy {
  defaultVisibility: "private";
  maxUploadsPerDay: number;
  minHoursBetweenUploads: number;
  quotaBudget: number;
  minScheduleLeadMinutes: number;
  repliesPerDay: number;
  secondsBetweenReplies: number;
}

export const POLICY_DEFAULTS: Readonly<Policy> = Object.freeze({
  defaultVisibility: "private",
  maxUploadsPerDay: 2,
  minHoursBetweenUploads: 6,
  quotaBudget: 8000,
  minScheduleLeadMinutes: 60,
  repliesPerDay: 10,
  secondsBetweenReplies: 90,
});

export const QUOTA_CEILING = 10_000;
const NUMERIC = ["maxUploadsPerDay", "minHoursBetweenUploads", "quotaBudget", "minScheduleLeadMinutes", "repliesPerDay", "secondsBetweenReplies"] as const;

export function parsePolicy(raw: unknown): Policy {
  const out: Policy = { ...POLICY_DEFAULTS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of NUMERIC) {
    const v = r[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  out.quotaBudget = Math.min(out.quotaBudget, QUOTA_CEILING); // Google's project quota is 10,000 a day
  return out; // visibility is not overridable: private by default, always
}
