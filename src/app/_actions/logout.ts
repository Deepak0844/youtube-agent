"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { logout } from "@/server/db/auth";
import { getPool } from "@/server/db/pool";
import { isSecureRequest, sessionCookieAttrs, SESSION_COOKIE, trustProxy } from "@/lib/auth/session-cookie";

// Acts only on the caller's own cookie token (nothing to authorise beyond holding it). Next's built-in Origin-vs-Host
// check guards the POST; a forged logout is a nuisance at most.
export async function logoutAction(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await logout(getPool(), token);
  const h = await headers();
  const secure = isSecureRequest({ protocol: h.get("origin")?.split("//")[0], forwardedProto: h.get("x-forwarded-proto"), trustProxy: trustProxy() });
  store.set(SESSION_COOKIE, "", sessionCookieAttrs(secure, 0));
  redirect("/login");
}
