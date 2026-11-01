import { open, rm } from "node:fs/promises";
import { KnownFailure } from "@/server/core/paid-call";
import { NotProcessedError } from "@/server/core/error-class";
import { BlockedAddressError, BlockedRedirectError, safeFetch } from "../net/safe-fetch";

// SECURITY CONTROL: the one door the three local voice adapters use to reach a server. Typed mode (so a private or loopback
// address must be on the owner's local-service list), no redirects at all, the key only in one request header and never in
// a URL, error or log line, and every body read has a size cap. Errors: a refusal seen before the server did any work is a
// NotProcessedError (KnownFailure); anything that fails after the request went out is rethrown as is (outcome unknown, parks).

/** Free adapters still go through the ledger (reserve 0) against the video's real scopes; none is a code bug, said plainly. */
export function requireScopes(scopes: readonly string[] | undefined, who: string): string[] {
  if (!scopes || scopes.length === 0) throw new KnownFailure(`${who} needs the video's budget scopes (internal wiring error).`);
  return [...scopes];
}

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const CALL_TIMEOUT_MS = 10 * 60_000; // covers the body too; ctx.paid has its own, shorter stage timeout
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const KEY_CHARS = /^[\x21-\x7e]{1,4096}$/;
const BAD_HEADERS = new Set(["host", "content-type", "content-length", "transfer-encoding", "connection"]);
const BEFORE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

export interface Access {
  localServices: readonly string[];
  getKey?: () => Promise<string | null>;
  headerName?: string; // custom adapter only; default Authorization (sent as Bearer)
}

function mapNetError(e: unknown): unknown {
  if (e instanceof BlockedAddressError || e instanceof BlockedRedirectError) return new NotProcessedError(e.message);
  if (e instanceof Error && e.message.startsWith("Too many redirects")) return new NotProcessedError("The voice server tried to redirect the request, which is refused.");
  const code = (e as { cause?: { code?: string } } | null)?.cause?.code;
  if (code !== undefined && BEFORE_SEND_CODES.has(code)) return new NotProcessedError("Could not reach the voice server.", { code });
  return e;
}

/**
 * `withKey: false` is for a follow-up fetch of a URL the server named: the key belongs to the configured server only.
 * `indirect` is for the same case: public hosts only, so a server-named URL can never reach a local service.
 */
export async function callServer(url: string, init: RequestInit, a: Access, signal: AbortSignal, opts: { withKey?: boolean; indirect?: boolean } = {}): Promise<Response> {
  const { withKey = true, indirect = false } = opts;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new NotProcessedError("The voice server address is not a valid URL.");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new NotProcessedError("The voice server address must start with http:// or https://.");
  if (target.username !== "" || target.password !== "") throw new NotProcessedError("The voice server address must not contain a user name or password.");
  const headers = new Headers(init.headers);
  if (withKey && a.getKey) {
    const key = await a.getKey();
    if (key) {
      const name = a.headerName ?? "Authorization";
      if (!HEADER_NAME.test(name) || BAD_HEADERS.has(name.toLowerCase())) throw new NotProcessedError("The key header name is not valid.");
      if (!KEY_CHARS.test(key)) throw new NotProcessedError("The voice server key has characters that cannot be sent.");
      headers.set(name, name.toLowerCase() === "authorization" ? `Bearer ${key}` : key);
    }
  }
  let res: Response;
  try {
    res = await safeFetch(target.href, { ...init, headers, redirect: "error", signal }, { ...(indirect ? { mode: "indirect" as const } : { mode: "typed" as const, localServices: a.localServices }), maxRedirects: 0, timeoutMs: CALL_TIMEOUT_MS });
  } catch (e) {
    throw mapNetError(e);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new NotProcessedError(`The voice server answered ${res.status}.`, { status: res.status });
  }
  return res;
}

export const postJson = (url: string, body: string, a: Access, signal: AbortSignal) =>
  callServer(url, { method: "POST", headers: { "content-type": "application/json" }, body }, a, signal);

async function drain(res: Response, cap: number, onChunk: (b: Uint8Array) => Promise<void> | void): Promise<void> {
  const tooBig = () => new Error(`The voice server sent more than ${Math.round(cap / 1048576)} MB; the download was stopped.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      n += value.length;
      if (n > cap) throw tooBig();
      await onChunk(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Streams the body to `file`, stopping at `cap` bytes. Any failure removes the partial file. */
export async function saveCapped(res: Response, file: string, cap = MAX_AUDIO_BYTES): Promise<void> {
  const fh = await open(file, "w", 0o600);
  try {
    await drain(res, cap, async (b) => { await fh.write(b); });
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => undefined);
    await rm(file, { force: true });
    throw e;
  }
}

export async function readJson(res: Response): Promise<unknown> {
  const parts: Buffer[] = [];
  await drain(res, MAX_JSON_BYTES, (b) => { parts.push(Buffer.from(b)); });
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("The voice server answered with something that is not JSON.");
  }
}
