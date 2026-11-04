"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { BAD_FORM, parseIdForm } from "@/server/core/queue-input";
import { reseedEvidence, saveAndVerifyEvidence } from "@/server/db/evidence";
import { getPool } from "@/server/db/pool";
import type { ActionResult } from "@/server/db/queue-actions";

// Evidence tab buttons. Owner session only (requireOwner, Origin check, then the form). The server re-checks every claim.
export type EvidenceState = Partial<ActionResult>;

export async function evidenceAction(_prev: EvidenceState, form: FormData): Promise<EvidenceState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = parseIdForm(form, "videoId");
  if (!id.ok) return { ok: false, message: BAD_FORM };
  const actor = { kind: "session", sessionId: owner.sessionId } as const;
  const db = getPool();
  if (form.get("intent") === "reseed") {
    const r = await reseedEvidence(db, id.value, actor);
    refresh();
    return r.ok ? { ok: true, message: `Started again from the script: ${r.count} claim(s). Fill in anything empty, then Save and verify.` } : { ok: false, message: r.message };
  }
  const raw = form.get("claims");
  let claims: unknown;
  try {
    claims = typeof raw === "string" && raw.length <= 200_000 ? JSON.parse(raw) : null;
  } catch {
    return { ok: false, message: BAD_FORM };
  }
  const r = await saveAndVerifyEvidence(db, id.value, claims, actor);
  refresh();
  if (!r.ok) return { ok: false, message: r.message };
  return r.verified
    ? { ok: true, message: "Saved and verified. Now sign off the evidence at the gate." }
    : { ok: false, message: `Saved, but not verified: ${r.problems.join("; ")}` };
}
