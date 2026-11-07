"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { decideProposal, noInsightsModel, runWeeklyReview } from "@/server/db/insights";
import { getPool } from "@/server/db/pool";

export interface InsightState {
  ok?: boolean;
  message?: string;
}

// Owner session only. A review reads our own database and may ask a text model for observations (capped); it never touches YouTube.
export async function runReviewAction(): Promise<InsightState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  try {
    // shortcut: no text model is wired here yet (no one-shot call outside a stage), so only the numbers are produced.
    const r = await runWeeklyReview(getPool(), noInsightsModel, { kind: "session", sessionId: owner.sessionId });
    refresh();
    return { ok: true, message: r.message };
  } catch {
    return { ok: false, message: "The review could not be written. Try again." };
  }
}

// Accepting records your decision and changes nothing else: no title, hook, idea or policy is touched.
export async function decideProposalAction(form: FormData): Promise<InsightState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = form.get("id");
  const decision = form.get("decision");
  if (typeof id !== "string" || (decision !== "accept" && decision !== "dismiss")) return { ok: false, message: "That did not look right. Reload and try again." };
  const r = await decideProposal(getPool(), id, decision, owner.sessionId);
  if (!r.ok) return { ok: false, message: r.error };
  refresh();
  return { ok: true, message: decision === "accept" ? "Noted. Nothing was changed for you." : "Dismissed." };
}
