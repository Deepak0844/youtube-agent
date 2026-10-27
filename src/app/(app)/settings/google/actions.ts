"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { recordAudit } from "@/server/db/audit";
import { saveOwnGoogleApp, testOwnGoogleApp } from "@/server/db/google-app";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import type { SaveState, TestState } from "./state";

const str = (v: FormDataEntryValue | null, max: number): string => (typeof v === "string" && v.length <= max ? v : "");

// Never returns, logs or audits the submitted secret.
export async function saveGoogleAppAction(_prev: SaveState, form: FormData): Promise<SaveState> {
  await requireOwner();
  const r = await saveOwnGoogleApp(getPool(), loadKeyring, { clientId: str(form.get("clientId"), 300), clientSecret: str(form.get("clientSecret"), 300) });
  if (!r.ok) {
    if (r.reason === "vault") return { status: "error", message: "The vault is not ready, so nothing was saved. Fix the vault key first." };
    return { status: "error", fieldErrors: r.fieldErrors };
  }
  refresh();
  return { status: "saved", message: "Saved. The secret is in the vault and cannot be shown again." };
}

// FORMAT ONLY: no request to Google. A real consent test arrives with the OAuth flow in Phase 5.
export async function testGoogleAppAction(_prev: TestState): Promise<TestState> {
  await requireOwner();
  void _prev;
  const pool = getPool();
  const result = await testOwnGoogleApp(pool, loadKeyring, process.env.APP_URL);
  await recordAudit(pool, "google_app.tested", { idOk: result.clientId, vaultOk: result.secret, redirectOk: result.redirectUri });
  return { status: "done", result };
}
