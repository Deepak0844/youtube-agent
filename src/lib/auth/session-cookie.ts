// Session cookie name, flags and parsing. Pure string work so the flags are unit-testable.
export const SESSION_COOKIE = "ytstudio_session";
export const SESSION_MAX_AGE_S = 7 * 24 * 3600; // the 7-day absolute limit; the server still enforces idle expiry

export function trustProxy(): boolean {
  return process.env.TRUST_PROXY === "1";
}

/**
 * Secure when the request is https. Our own code reads x-forwarded-proto only with TRUST_PROXY=1; note that Next itself
 * builds request.url from the forwarded proto, so without TRUST_PROXY a client can already make `protocol` https. That
 * only makes the cookie Secure (stricter), never weaker.
 */
export function isSecureRequest(o: { protocol: string | null | undefined; forwardedProto: string | null | undefined; trustProxy: boolean }): boolean {
  if (o.trustProxy && o.forwardedProto) return o.forwardedProto.split(",").pop()!.trim().toLowerCase() === "https";
  return o.protocol === "https:";
}

export interface CookieAttrs {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
}
export const sessionCookieAttrs = (secure: boolean, maxAge = SESSION_MAX_AGE_S): CookieAttrs => ({ httpOnly: true, sameSite: "lax", path: "/", maxAge, secure });

function serialize(value: string, a: CookieAttrs): string {
  return `${SESSION_COOKIE}=${value}; Max-Age=${a.maxAge}; Path=${a.path}; HttpOnly; SameSite=Lax${a.secure ? "; Secure" : ""}`;
}
export const serializeSessionCookie = (token: string, o: { secure: boolean }): string => serialize(token, sessionCookieAttrs(o.secure));
export const serializeClearCookie = (o: { secure: boolean }): string => serialize("", sessionCookieAttrs(o.secure, 0));

/** Exact-name lookup in a Cookie header; the first match wins; empty value = absent. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) {
      const v = part.slice(i + 1).trim();
      return v.length > 0 && v.length <= 256 ? v : null;
    }
  }
  return null;
}
