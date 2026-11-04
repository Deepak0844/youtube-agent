import type pg from "pg";
import { actorProblem, ACTOR_REASON, type GateActor } from "@/server/core/approvals";
import { canonicalJson, sha256Hex } from "@/server/core/content-hash";
import { claimsOf, claimsSha, HEAD_TIMEOUT_MS, MAX_SOURCE_URLS, parseClaims, seedClaims, sourceUrls, type UrlResult, type Verification } from "@/server/core/evidence-edit";
import type { Claim } from "@/server/core/script-contract";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { recordAudit } from "./audit";
import { addContent, latestContent } from "./videos";

// Evidence tab actions. OWNER SESSION ONLY: verifying evidence is a human-gate action, so every function takes a GateActor and
// refuses anything else (an agent, a token, a missing actor). Each save adds a new `evidence` version (append-only), so the
// evidence sign-off and any publish approval built on the old version stop counting.

/** One HEAD request, no retries. Returns the HTTP status, or throws (blocked address, timeout, bad host). */
export type HeadCheck = (url: string) => Promise<number>;
export const defaultHead: HeadCheck = async (url) => {
  const res = await safeFetch(url, { method: "HEAD" }, { mode: "indirect", timeoutMs: HEAD_TIMEOUT_MS, maxRedirects: 3 });
  await res.body?.cancel().catch(() => undefined);
  return res.status;
};

async function checkUrl(head: HeadCheck, url: string): Promise<UrlResult> {
  try {
    const status = await head(url);
    // 405 / 501: the site does not answer HEAD but did answer, so the address exists.
    if (status < 400) return { url, ok: true, status, note: "reachable" };
    if (status === 405 || status === 501) return { url, ok: true, status, note: "reachable (the site does not allow HEAD)" };
    return { url, ok: false, status, note: `the page answered ${status}` };
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    return { url, ok: false, status: null, note: /abort|timeout/i.test(m) ? "no answer in time" : "could not be reached or is not allowed" };
  }
}

export interface EvidenceView {
  claims: Claim[];
  verification: Verification | null;
  /** the newest evidence is claim based (false: only a file exists, so editing starts from the script) */
  stored: boolean;
  verifiedNow: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function loadEvidence(db: pg.Pool, videoId: string): Promise<EvidenceView> {
  const ev = await latestContent(db, videoId, "evidence");
  const body = isObj(ev?.body) ? ev!.body : null;
  if (body && Array.isArray(body.claims)) {
    // A re-seeded draft can hold claims that are not complete yet; the editor still shows them so the owner can finish them.
    const valid = claimsOf(body);
    const v = isObj(body.verification) ? (body.verification as unknown as Verification) : null;
    return { claims: body.claims as Claim[], verification: v, stored: true, verifiedNow: valid !== null && v !== null && v.ok === true && v.claims_sha === claimsSha(valid) };
  }
  const script = await latestContent(db, videoId, "script");
  const fromScript = parseClaims(isObj(script?.body) ? script!.body.evidence : undefined);
  return { claims: fromScript.ok ? fromScript.claims : [], verification: null, stored: false, verifiedNow: false };
}

export type EvidenceResult = { ok: true; verified: boolean; problems: string[]; results: UrlResult[] } | { ok: false; message: string };

async function writeEvidence(db: pg.Pool, videoId: string, claims: Claim[], verification: Verification | null): Promise<void> {
  const body = verification ? { claims, verification } : { claims };
  await addContent(db, videoId, "evidence", { body, sha256: sha256Hex(canonicalJson(body)), producedBy: null });
}

async function liveVideo(db: pg.Pool, videoId: string): Promise<string | null> {
  const v = await db.query<{ status: string }>("select status from videos where id = $1", [videoId]);
  if (!v.rows[0]) return "That video was not found.";
  return ["active", "waiting"].includes(v.rows[0].status) ? null : "This video is no longer in production.";
}

/**
 * Save the claims and verify them: every claim is well formed, there is at least one, and every sourced link answers a HEAD
 * request through safeFetch (public addresses only, 8 s timeout, at most 10 links, one try each). The result is stored with
 * the claims; a failed check is still saved (with the reasons) so the owner can see and fix it.
 */
export async function saveAndVerifyEvidence(db: pg.Pool, videoId: string, rawClaims: unknown, actor: GateActor, head: HeadCheck = defaultHead): Promise<EvidenceResult> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const parsed = parseClaims(rawClaims);
  if (!parsed.ok) return { ok: false, message: parsed.problems.join("; ") };
  const gone = await liveVideo(db, videoId);
  if (gone) return { ok: false, message: gone };
  const claims = parsed.claims;
  const problems: string[] = [];
  if (claims.length === 0) problems.push("add at least one claim");
  const urls = sourceUrls(claims);
  const results: UrlResult[] = [];
  if (urls.length > MAX_SOURCE_URLS) problems.push(`too many different sources to check (${urls.length}; the most is ${MAX_SOURCE_URLS})`);
  else for (const u of urls) results.push(await checkUrl(head, u)); // one at a time, no retry
  for (const r of results) if (!r.ok) problems.push(`${r.url}: ${r.note}`);
  const verification: Verification = { at: new Date().toISOString(), by: "owner", claims_sha: claimsSha(claims), ok: problems.length === 0, problems, results };
  await writeEvidence(db, videoId, claims, verification);
  await recordAudit(db, "evidence.verified", { videoId, sessionId: actor.sessionId, ok: verification.ok, sourcesChecked: results.length, claims: claims.length });
  return { ok: true, verified: verification.ok, problems, results };
}

/** Replace the claims with a fresh start from the approved script (its own claims, or numbers in the narration). Not verified. */
export async function reseedEvidence(db: pg.Pool, videoId: string, actor: GateActor): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  if (actorProblem(actor)) return { ok: false, message: ACTOR_REASON };
  const gone = await liveVideo(db, videoId);
  if (gone) return { ok: false, message: gone };
  const script = await latestContent(db, videoId, "script");
  if (!isObj(script?.body)) return { ok: false, message: "There is no script to start from." };
  const seeded = seedClaims(script!.body);
  // Seeded claims may be incomplete on purpose (an empty "how it was computed"): keep them as plain objects until the owner fills them in.
  const body = { claims: seeded };
  await addContent(db, videoId, "evidence", { body, sha256: sha256Hex(canonicalJson(body)), producedBy: null });
  await recordAudit(db, "evidence.reseeded", { videoId, sessionId: actor.sessionId, claims: seeded.length });
  return { ok: true, count: seeded.length };
}
