import type pg from "pg";
import { sha256Hex } from "@/server/core/content-hash";
import { claimsSha } from "@/server/core/evidence-edit";
import type { Claim } from "@/server/core/script-contract";
import { addContent } from "@/server/db/videos";

// Content that passes the publish approval: the full saved upload details, and claim-based evidence with an owner
// verification made for exactly those claims. Used by every test that approves a publish.

export const DETAILS = { title: "t", description: "d", tags: ["a"], category_id: 27, language: "en", made_for_kids: false, synthetic_content: false };

/** A metadata body with valid upload details. */
export const metaBody = (o: { visibility?: string; publishAt?: string | null; title?: string } = {}) => ({
  ...DETAILS,
  ...(o.title ? { title: o.title } : {}),
  visibility: o.visibility ?? "private",
  publish_at: o.publishAt ?? null,
});

const CLAIMS: Claim[] = [{ text: "c", kind: "computed", method: "m" }];
/** Claim-based evidence that is verified for exactly its claims. */
export const VERIFIED_EVIDENCE = {
  claims: CLAIMS,
  verification: { at: "2026-01-01T00:00:00.000Z", by: "owner", claims_sha: claimsSha(CLAIMS), ok: true, problems: [], results: [] },
};

/** A new evidence version that is verified. A different `tag` gives a different version (and so a different hash). */
export async function addVerifiedEvidence(db: pg.Pool, videoId: string, tag = "evidence"): Promise<void> {
  await addContent(db, videoId, "evidence", { body: VERIFIED_EVIDENCE, sha256: sha256Hex(tag) });
}
