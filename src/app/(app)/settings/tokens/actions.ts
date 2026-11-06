"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { parseNewToken } from "@/server/core/api-token";
import { createApiToken, revokeApiToken } from "@/server/db/api-tokens";
import { recordAudit } from "@/server/db/audit";
import { getPool } from "@/server/db/pool";
import type { CreateState } from "./state";

// Session only (requireOwner reads the cookie only), so a token can never create or revoke tokens.
// The secret goes back to the browser once in the returned state; it is never stored, logged or audited.
export async function createTokenAction(_prev: CreateState, form: FormData): Promise<CreateState> {
  const { sessionId } = await requireOwner();
  const parsed = parseNewToken({ name: form.get("name"), scopes: form.getAll("scopes"), cap: form.get("cap") });
  if (!parsed.ok) return { status: "error", message: parsed.error };
  const pool = getPool();
  const t = await createApiToken(pool, parsed.value);
  await recordAudit(pool, "api_token.created", { ref: t.id, name: parsed.value.name, prefix: t.prefix, scopes: parsed.value.scopes, dailyDraftCap: parsed.value.dailyDraftCap, sessionId });
  refresh();
  return { status: "created", secret: t.secret, name: parsed.value.name };
}

export async function revokeTokenAction(form: FormData): Promise<void> {
  const { sessionId } = await requireOwner();
  const id = form.get("id");
  if (typeof id !== "string") return;
  const pool = getPool();
  const r = await revokeApiToken(pool, id);
  if (r) await recordAudit(pool, "api_token.revoked", { ref: id, name: r.name, prefix: r.prefix, sessionId });
  refresh();
}
