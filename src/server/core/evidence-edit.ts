// Evidence tab rules (Phase 5 slice 3). Pure: no IO. The evidence content body is { claims, verification? }. Only an owner
// session writes `verification`; the Draft stage and the model never do. A verification counts only while it still matches
// the claims it was made for (claims_sha), so any edit after verifying makes the evidence unverified again.
import { z } from "zod";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { claimSchema, type Claim } from "@/server/core/script-contract";

export const MAX_CLAIMS = 40;
export const MAX_SOURCE_URLS = 10;
export const HEAD_TIMEOUT_MS = 8_000;

export interface UrlResult { url: string; ok: boolean; status: number | null; note: string }
export interface Verification {
  at: string;
  by: "owner";
  claims_sha: string;
  ok: boolean;
  /** plain-words reasons when ok is false */
  problems: string[];
  results: UrlResult[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const claimsSha = (claims: readonly Claim[]): string => sha256Hex(canonicalJson(claims));

export function parseClaims(raw: unknown): { ok: true; claims: Claim[] } | { ok: false; problems: string[] } {
  if (!Array.isArray(raw)) return { ok: false, problems: ["the claims must be a list"] };
  if (raw.length > MAX_CLAIMS) return { ok: false, problems: [`at most ${MAX_CLAIMS} claims`] };
  const r = z.array(claimSchema).safeParse(raw);
  if (r.success) return { ok: true, claims: r.data };
  return { ok: false, problems: [...new Set(r.error.issues.map((i) => `claim ${Number(i.path[0]) + 1}: ${i.path[1] === "source_url" ? "the link must be a full http(s) address" : i.path[1] === "method" ? "say how it was computed" : i.path[1] === "quote" ? "add the quote from the source" : i.path[1] === "text" ? "write the claim" : "check the kind"}`))] };
}

export const sourceUrls = (claims: readonly Claim[]): string[] => [...new Set(claims.flatMap((c) => (c.kind === "sourced" ? [c.source_url] : [])))];

/** The stored claims of an evidence body, or null when the body is not claim based (a file, or unreadable). */
export function claimsOf(body: unknown): Claim[] | null {
  if (!isObj(body)) return null;
  const r = parseClaims(body.claims);
  return r.ok ? r.claims : null;
}

/** True only when the body carries an owner verification that is ok AND was made for exactly these claims. */
export function evidenceVerified(body: unknown): boolean {
  if (!isObj(body)) return false;
  const claims = claimsOf(body);
  const v = body.verification;
  return claims !== null && claims.length > 0 && isObj(v) && v.ok === true && v.by === "owner" && v.claims_sha === claimsSha(claims);
}

/** Does the publish approval have to refuse for lack of verification? Claim-based evidence must be verified; a body that is not claims (a file-only row) is refused too. */
export function evidenceVerificationProblem(requireEvidence: unknown, body: unknown): string | null {
  if (requireEvidence === false) return null;
  if (!isObj(body)) return "the evidence must be claims that are verified (Evidence tab: Save and verify) before publishing";
  return evidenceVerified(body) ? null : "the evidence must be verified (Evidence tab: Save and verify) before publishing";
}

/** Claims to start from: the script's own claims; if it has none, one empty computed claim per narration sentence with a number (the owner fills the method). */
export function seedClaims(script: { evidence?: unknown; narration?: unknown }): Array<Record<string, unknown>> {
  const have = parseClaims(script.evidence);
  if (have.ok && have.claims.length > 0) return have.claims;
  const narration = typeof script.narration === "string" ? script.narration : "";
  return narration.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => /\d/.test(s)).slice(0, 8).map((text) => ({ text, kind: "computed", method: "" }));
}
