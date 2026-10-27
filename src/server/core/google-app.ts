// Own Google Cloud app: pure format rules. No IO, no network: the "test" on /settings/google only checks shapes.
// Error text never contains the submitted value (the secret must never be echoed).

export const CALLBACK_PATH = "/api/oauth/google/callback";
export const SECRET_NAME = "google.app.client_secret";

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{5,99}\.apps\.googleusercontent\.com$/i;
const SECRET_RE = /^[\x21-\x7e]{8,256}$/; // printable ASCII, no whitespace

export type Checked = { ok: true; value: string } | { ok: false; error: string };

export function validateClientId(raw: string): Checked {
  const v = raw.trim();
  return CLIENT_ID_RE.test(v) ? { ok: true, value: v } : { ok: false, error: "That does not look like a Google client ID. It ends in .apps.googleusercontent.com." };
}

/** A paste usually brings ONE trailing newline or space; drop exactly that. Anything else is the owner's to fix. */
export const stripPastedTail = (raw: string): string => raw.replace(/(?:\r?\n| )$/, "");

// Phase 5 note: the token request must send this secret form-encoded (URLSearchParams). It may contain & " % + and must
// never be concatenated into a body or URL by hand.
export function validateClientSecret(raw: string): Checked {
  return SECRET_RE.test(raw) ? { ok: true, value: raw } : { ok: false, error: "The client secret should be 8 to 256 visible characters with no spaces." };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function parseBase(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u;
  return null;
}

/** Redirect URI to paste into Google, from APP_URL. https, or http only for localhost / 127.0.0.1. */
export function redirectUriFor(appUrl: string | undefined): { ok: true; uri: string } | { ok: false; error: string } {
  const raw = appUrl?.trim() || "http://localhost:3000";
  const u = parseBase(raw);
  if (!u) return { ok: false, error: "APP_URL must be https, or http on localhost or 127.0.0.1, so Google will accept the redirect address." };
  // The redirect address is built from the origin only, so a path would be silently dropped: refuse it instead.
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return { ok: false, error: "APP_URL must be just the address (scheme, host and port), with no path, query or fragment." };
  return { ok: true, uri: `${u.origin}${CALLBACK_PATH}` };
}

export function validateRedirectUri(uri: string): boolean {
  const u = parseBase(uri);
  return !!u && u.pathname === CALLBACK_PATH && !u.search && !u.hash;
}

/** 1234…apps.googleusercontent.com: keeps the number prefix and the suffix, hides the middle. */
export function maskClientId(id: string): string {
  const suffix = ".apps.googleusercontent.com";
  if (!id.toLowerCase().endsWith(suffix)) return "…";
  return `${id.slice(0, 4)}…${id.slice(-suffix.length)}`;
}

type Field = "clientId" | "clientSecret" | "form";
export type GoogleAppInput = { ok: true; clientId?: string; clientSecret?: string } | { ok: false; fieldErrors: Partial<Record<Field, string>> };

/** Blank fields keep what is stored. Both are needed when nothing is stored, and something must change. */
export function googleAppInput(raw: { clientId: string; clientSecret: string }, stored: { hasId: boolean; hasSecret: boolean }): GoogleAppInput {
  const fieldErrors: Partial<Record<Field, string>> = {};
  const out: { clientId?: string; clientSecret?: string } = {};
  if (raw.clientId.trim() !== "") {
    const r = validateClientId(raw.clientId);
    if (r.ok) out.clientId = r.value;
    else fieldErrors.clientId = r.error;
  } else if (!stored.hasId) fieldErrors.clientId = "Enter the client ID from Google.";
  const secret = stripPastedTail(raw.clientSecret);
  if (secret !== "") {
    const r = validateClientSecret(secret);
    if (r.ok) out.clientSecret = r.value;
    else fieldErrors.clientSecret = r.error;
  } else if (!stored.hasSecret) fieldErrors.clientSecret = "Enter the client secret from Google.";
  if (Object.keys(fieldErrors).length === 0 && out.clientId === undefined && out.clientSecret === undefined) fieldErrors.form = "Nothing to save: both fields are empty.";
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, ...out };
}
