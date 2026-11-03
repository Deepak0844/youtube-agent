// Policy defaults in ONE place (Phase 5; the file reader is src/server/db/policy-file.ts). ops/policy.json, when it exists, overrides single fields; a missing file, bad JSON
// or a field of the wrong type falls back to the built-in value for that field. The owner's per-channel settings can only
// make these stricter at upload time (the publish path takes the smaller cap and the longer gap).
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

const NUMERIC = ["maxUploadsPerDay", "minHoursBetweenUploads", "quotaBudget", "minScheduleLeadMinutes", "repliesPerDay", "secondsBetweenReplies"] as const;

export function parsePolicy(raw: unknown): Policy {
  const out: Policy = { ...POLICY_DEFAULTS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of NUMERIC) {
    const v = r[k];
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out; // visibility is not overridable: private by default, always
}
