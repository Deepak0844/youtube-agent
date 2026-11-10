"use server";

import { cookies, headers } from "next/headers";
import { refresh } from "next/cache";
import { assertActionOrigin } from "@/lib/auth/action-origin";
import { ensureAuthConfigured } from "@/lib/auth/auth-config";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { requireOwner } from "@/lib/auth/require-owner";
import { isSecureRequest, sessionCookieAttrs, SESSION_COOKIE, trustProxy } from "@/lib/auth/session-cookie";
import { changePasswordMessage, passwordFormProblem } from "@/server/core/account-view";
import { changePassword, revokeOtherSessions, revokeSession } from "@/server/db/auth";
import { recordAudit } from "@/server/db/audit";
import { ownerUsername } from "@/server/db/owner";
import { getPool } from "@/server/db/pool";

// The Account page. Session only: requireOwner reads the cookie, so an API token can never change the password or sign sessions out.
// Same guard order as the other owner actions: requireOwner, Origin check, then the form. Typed passwords are never returned, logged or audited.
export type AccountState = { ok?: boolean; message?: string };

const str = (v: FormDataEntryValue | null): string => (typeof v === "string" ? v : "");

export async function changePasswordAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { sessionId } = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  ensureAuthConfigured();
  const current = str(form.get("current"));
  const next = str(form.get("next"));
  const again = str(form.get("again"));
  const db = getPool();
  const name = (await ownerUsername(db)) ?? "";
  const problem = passwordFormProblem(current, next, again, name);
  if (problem) return { ok: false, message: problem };
  const h = await headers();
  const r = await changePassword(db, sessionId, current, next, clientIpFrom(h, { trustProxy: trustProxy() }));
  if (!r.ok) return { ok: false, message: changePasswordMessage(r.reason) };
  // The change signed every other session out and gave THIS session a new token: the browser must hold the new one or it would be signed out next click.
  const secure = isSecureRequest({ protocol: h.get("origin")?.split("//")[0], forwardedProto: h.get("x-forwarded-proto"), trustProxy: trustProxy() });
  (await cookies()).set(SESSION_COOKIE, r.token, sessionCookieAttrs(secure));
  refresh();
  return { ok: true, message: "Password changed. Every other sign-in was signed out." };
}

export async function signOutOthersAction(): Promise<AccountState> {
  const { sessionId } = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const db = getPool();
  const n = await revokeOtherSessions(db, sessionId);
  await recordAudit(db, "sessions.others_revoked", { count: n, sessionId });
  refresh();
  return { ok: true, message: n === 0 ? "There were no other sign-ins." : `Signed out ${n} other sign-in${n === 1 ? "" : "s"}.` };
}

export async function signOutSessionAction(_prev: AccountState, form: FormData): Promise<AccountState> {
  const { sessionId } = await requireOwner();
  const origin = await assertActionOrigin();
  if (origin) return { ok: false, message: origin };
  const id = str(form.get("id"));
  if (id === sessionId) return { ok: false, message: "That is this sign-in. Use Sign out in the account menu." };
  const db = getPool();
  const done = await revokeSession(db, id);
  if (done) await recordAudit(db, "session.revoked", { revoked: id, sessionId });
  refresh();
  return done ? { ok: true, message: "Signed out." } : { ok: false, message: "That sign-in was not found." };
}
