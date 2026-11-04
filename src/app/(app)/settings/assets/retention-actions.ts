"use server";

import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { requireOwner } from "@/lib/auth/require-owner";
import { getPool } from "@/server/db/pool";
import { planRetention, runRetention, type RetentionPlan } from "@/server/db/retention";
import { storageRoot } from "@/server/storage/paths";

export interface RetentionState {
  plan?: RetentionPlan;
  done?: boolean;
  error?: string;
}

// Owner session only. "preview" changes nothing; "run" deletes (it re-checks everything at that moment).
export async function retentionAction(_prev: RetentionState, form: FormData): Promise<RetentionState> {
  const owner = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { error: origin };
  const run = form.get("mode") === "run";
  try {
    if (!run) return { plan: await planRetention(getPool(), storageRoot()) };
    const plan = await runRetention(getPool(), storageRoot(), { kind: "session", sessionId: owner.sessionId });
    refresh();
    return { plan, done: true };
  } catch {
    return { error: "The clean-up could not finish. Nothing more was removed. Try again." };
  }
}
