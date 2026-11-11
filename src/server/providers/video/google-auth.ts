import { createSign } from "node:crypto";
import { NotProcessedError } from "@/server/core/error-class";
import type { SafeFetch } from "../voice/eleven-types";
import { readCapped } from "../voice/elevenlabs";

// Google service-account sign-in: sign a short JWT with the account's private key and swap it for an access token. Nothing is sent to the
// paid video endpoint until this has worked, so every failure here is "refused before work".
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new NotProcessedError("The Google Cloud key file could not be read.");
  }
  if (j.type !== "service_account" || typeof j.project_id !== "string" || !/^[a-z][a-z0-9-]{4,60}$/.test(j.project_id) || typeof j.client_email !== "string" || typeof j.private_key !== "string") {
    throw new NotProcessedError("The saved Google Cloud key is not a service-account file.");
  }
  return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
}

/** The signed request for an access token (RS256). `now` is seconds since 1970. */
export function signedAssertion(sa: ServiceAccount, now: number): string {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key);
  return `${head}.${claim}.${b64u(sig)}`;
}

/** One token request. The key and the token are never put in an error message. */
export async function fetchAccessToken(f: SafeFetch, sa: ServiceAccount, now: number, signal: AbortSignal): Promise<string> {
  let assertion: string;
  try {
    assertion = signedAssertion(sa, now);
  } catch {
    throw new NotProcessedError("The Google Cloud private key could not be used to sign in.");
  }
  let res: Response;
  try {
    res = await f(TOKEN_URL, {
      method: "POST", signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    }, { timeoutMs: 60_000, maxRedirects: 0 });
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new NotProcessedError("Google sign-in could not be reached.");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new NotProcessedError(`Google refused the sign-in (${res.status}).`, { status: res.status });
  }
  let token: unknown;
  try {
    token = (JSON.parse((await readCapped(res, "Google sign-in")).toString("utf8")) as { access_token?: unknown }).access_token;
  } catch {
    throw new NotProcessedError("Google sign-in sent an answer that could not be read.");
  }
  if (typeof token !== "string" || token.length < 20 || token.length > 4096 || /\s/.test(token)) throw new NotProcessedError("Google sign-in sent no usable token.");
  return token;
}
