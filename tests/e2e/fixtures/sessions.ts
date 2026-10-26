import pg from "pg";
import { hashToken } from "@/server/core/auth-crypto";
import { login, logout } from "@/server/db/auth";
import { OWNER_PASSWORD, OWNER_USERNAME } from "./owner";

// Test-only helpers: mint, expire and revoke real sessions for the seeded owner straight in the database that the e2e
// server uses (E2E_DATABASE_URL is exported by global-setup).
let pool: pg.Pool | undefined;
const db = () => (pool ??= new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 }));
let n = 0;

export async function mintSession(): Promise<string> {
  const ip = `198.51.100.${10 + (n++ % 200)}`;
  const r = await login(db(), { username: OWNER_USERNAME, password: OWNER_PASSWORD, ip, userAgent: "e2e" });
  if (!r.ok) throw new Error(`could not mint a session: ${r.reason}`);
  return r.token;
}
// created_at must stay <= last_seen_at: validateSession THROWS on the reverse (and fails closed), which would make an
// "expired" session look refused for the wrong reason and hide a broken expiry check.
export async function expireSession(token: string): Promise<void> {
  const hash = hashToken(token);
  await db().query(
    "update sessions set created_at = now() - interval '10 hours', last_seen_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' where token_hash = $1",
    [hash],
  );
}
/** Past the 7-day absolute limit while still recently active (idle check alone would let it through). */
export async function expireSessionAbsolute(token: string): Promise<void> {
  const hash = hashToken(token);
  await db().query(
    "update sessions set created_at = now() - interval '8 days', last_seen_at = now(), expires_at = now() + interval '8 hours', absolute_expires_at = now() - interval '1 day' where token_hash = $1",
    [hash],
  );
}
export const revokeSession = (token: string) => logout(db(), token);
export async function endSessionPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
