"use server";

import { refresh } from "next/cache";
import { requireOwner } from "@/lib/auth/require-owner";
import { recordAudit } from "@/server/db/audit";
import { saveOwnGoogleApp, testOwnGoogleApp } from "@/server/db/google-app";
import { loadKeyring } from "@/server/db/master-key";
import { getPool } from "@/server/db/pool";
import type { SaveState, TestState } from "./state";

// A value is passed on untouched so the real rules judge it. Over-length or non-text input must never be read as blank
// ("keep what is stored") with a success message: it is a field error. The 1000 cap only bounds work on absurd input; the
// validators (secret 256, client id 100) give the precise message for anything shorter.
const MAX_RAW = 1000;
type Field = "clientId" | "clientSecret";
function field(form: FormData, name: Field): { value: string } | { error: string } {
  const v = form.get(name);
  if (v === null) return { value: "" };
  if (typeof v !== "string") return { error: "Enter text only." };
  if (v.length > MAX_RAW) return { error: name === "clientSecret" ? "The client secret should be 8 to 256 visible characters with no spaces." : "That does not look like a Google client ID. It ends in .apps.googleusercontent.com." };
  return { value: v };
}

// Never returns, logs or audits the submitted secret.
export async function saveGoogleAppAction(_prev: SaveState, form: FormData): Promise<SaveState> {
  await requireOwner();
  const id = field(form, "clientId");
  const secret = field(form, "clientSecret");
  if ("error" in id || "error" in secret) {
    return { status: "error", fieldErrors: { ...("error" in id ? { clientId: id.error } : {}), ...("error" in secret ? { clientSecret: secret.error } : {}) } };
  }
  const r = await saveOwnGoogleApp(getPool(), loadKeyring, { clientId: id.value, clientSecret: secret.value });
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
