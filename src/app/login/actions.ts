"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { ensureAuthConfigured } from "@/lib/auth/auth-config";
import { safeNext } from "@/lib/auth/policy";
import { isSecureRequest, sessionCookieAttrs, SESSION_COOKIE, trustProxy } from "@/lib/auth/session-cookie";
import { login } from "@/server/db/auth";
import { getPool } from "@/server/db/pool";

export interface LoginState {
  error?: string;
  needCode?: boolean;
}

const str = (v: FormDataEntryValue | null, max: number): string => (typeof v === "string" && v.length <= max ? v : "");

// Server Action: Next's built-in Origin-vs-Host check runs before this body. The token never leaves the cookie.
export async function loginAction(prev: LoginState, form: FormData): Promise<LoginState> {
  ensureAuthConfigured();
  const username = str(form.get("username"), 200);
  const password = str(form.get("password"), 1024);
  const code = str(form.get("code"), 32);
  const next = safeNext(form.get("next"));
  const h = await headers();

  const r = await login(getPool(), {
    username,
    password,
    code: code || undefined,
    ip: clientIpFrom(h, { trustProxy: trustProxy() }),
    userAgent: h.get("user-agent") ?? undefined,
  });

  if (!r.ok) {
    if (r.reason === "needs_totp") return { needCode: true };
    if (r.reason === "locked") {
      const min = Math.max(1, Math.ceil((r.retryAfterMs ?? 60_000) / 60_000));
      return { needCode: prev.needCode, error: `Too many attempts. Try again in ${min} minute${min === 1 ? "" : "s"}.` };
    }
    if (r.reason === "vault")
      return { needCode: prev.needCode, error: "Two-factor sign-in is unavailable: the vault key is missing or wrong. Restore VAULT_MASTER_KEY, or run npm run owner:reset." };
    if (r.reason === "busy") return { needCode: prev.needCode, error: "Busy right now. Try again in a moment." };
    return { needCode: prev.needCode, error: prev.needCode ? "Incorrect username, password or code." : "Incorrect username or password." };
  }
  const secure = isSecureRequest({ protocol: h.get("origin")?.split("//")[0], forwardedProto: h.get("x-forwarded-proto"), trustProxy: trustProxy() });
  (await cookies()).set(SESSION_COOKIE, r.token, sessionCookieAttrs(secure));
  redirect(next);
}
