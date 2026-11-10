import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The Account page's server actions on a real database. Only the Next request plumbing is faked (headers, cookies, refresh, and requireOwner, which
// would read the browser's cookie); the password change, session checks and audit are the real code.
const h = vi.hoisted(() => ({
  pool: null as unknown,
  session: "" as string,
  headers: new Headers(),
  cookieSets: [] as Array<{ name: string; value: string; attrs: Record<string, unknown> }>,
}));
vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({ set: (name: string, value: string, attrs: Record<string, unknown>) => void h.cookieSets.push({ name, value, attrs }) }),
}));
vi.mock("next/cache", () => ({ refresh: () => undefined }));
vi.mock("@/lib/auth/require-owner", () => ({ requireOwner: async () => ({ sessionId: h.session }) }));
vi.mock("@/server/db/pool", async (orig) => ({ ...(await orig<typeof import("@/server/db/pool")>()), getPool: () => h.pool }));

import { changePasswordAction, signOutOthersAction, signOutSessionAction } from "@/app/(app)/settings/account/actions";
import { login, validateSession } from "@/server/db/auth";
import { consumeSetupLink, createSetupLink } from "@/server/db/owner";
import { SESSION_COOKIE } from "@/lib/auth/session-cookie";
import { withTestDb, type TestDb } from "../support/db";

const BASE = "http://localhost:3000";
const PW = "correct horse battery staple";
const NEWPW = "another long passphrase 42";
let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
  h.pool = db.pool;
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
  h.cookieSets.length = 0;
  h.headers = new Headers({ origin: BASE, host: "localhost:3000", "user-agent": "test" });
});

const q = (sql: string, params: unknown[] = []) => db.pool.query(sql, params);
async function makeOwner(): Promise<void> {
  const l = await createSetupLink(db.pool, "create", BASE);
  expect(await consumeSetupLink(db.pool, l.slice(`${BASE}/setup/`.length), { username: "alice", password: PW })).toEqual({ ok: true });
}
/** A real sign-in: returns its token and its session id (what requireOwner would give). */
async function signIn(): Promise<{ token: string; id: string }> {
  const r = await login(db.pool, { username: "alice", password: PW, ip: "10.0.0.1", userAgent: "ua" });
  if (!r.ok) throw new Error("login failed");
  const s = await validateSession(db.pool, r.token);
  if (!s.ok) throw new Error("no session");
  return { token: r.token, id: s.sessionId };
}
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const auditEvents = async (like: string) => (await q("select event, detail from audit_log where event like $1", [like])).rows;
const failures = async () => Number((await q("select count(*) n from login_attempts where not success")).rows[0].n);

describe("changePasswordAction", () => {
  it("success: new password works, the old one does not, this session gets a NEW token in the cookie, every other session is signed out, and nothing typed is audited", async () => {
    await makeOwner();
    const me = await signIn();
    const other = await signIn();
    h.session = me.id;
    const r = await changePasswordAction({}, form({ current: PW, next: NEWPW, again: NEWPW }));
    expect(r).toEqual({ ok: true, message: "Password changed. Every other sign-in was signed out." });

    expect(h.cookieSets).toHaveLength(1);
    const c = h.cookieSets[0]!;
    expect(c.name).toBe(SESSION_COOKIE);
    expect(c.value).not.toBe(me.token); // rotated
    expect(c.attrs).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect((await validateSession(db.pool, me.token)).ok).toBe(false); // the old token is dead
    expect(await validateSession(db.pool, c.value)).toEqual({ ok: true, sessionId: me.id }); // the new one is this same session
    expect((await validateSession(db.pool, other.token)).ok).toBe(false); // the other sign-in was signed out

    expect((await login(db.pool, { username: "alice", password: NEWPW, ip: "10.0.0.2", userAgent: "ua" })).ok).toBe(true);
    expect((await login(db.pool, { username: "alice", password: PW, ip: "10.0.0.3", userAgent: "ua" })).ok).toBe(false);
    const a = JSON.stringify(await auditEvents("password.%"));
    expect(a).toContain("password.changed");
    for (const secret of [PW, NEWPW, c.value, me.token]) expect(a).not.toContain(secret);
  });

  it("a wrong current password changes nothing, sets no cookie, keeps the other sessions, and counts as a failed try", async () => {
    await makeOwner();
    const me = await signIn();
    const other = await signIn();
    h.session = me.id;
    const r = await changePasswordAction({}, form({ current: "not the password", next: NEWPW, again: NEWPW }));
    expect(r).toEqual({ ok: false, message: "The current password is not right. Nothing was changed." });
    expect(h.cookieSets).toHaveLength(0);
    expect((await validateSession(db.pool, me.token)).ok).toBe(true);
    expect((await validateSession(db.pool, other.token)).ok).toBe(true);
    expect(await failures()).toBe(1);
  });

  it("problems the form can see (mismatch, too short, common, same as current, empty) are told at once and never reach the password check or count as failures", async () => {
    await makeOwner();
    const me = await signIn();
    h.session = me.id;
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ current: PW, next: NEWPW, again: `${NEWPW}x` }, /not the same/],
      [{ current: PW, next: "short", again: "short" }, /at least 12/],
      [{ current: PW, next: "password1234", again: "password1234" }, /too common/],
      [{ current: PW, next: PW, again: PW }, /same as the current/],
      [{ current: "", next: NEWPW, again: NEWPW }, /current password/],
    ];
    for (const [f, re] of cases) {
      const r = await changePasswordAction({}, form(f));
      expect(r.ok, JSON.stringify(f)).toBe(false);
      expect(r.message).toMatch(re);
    }
    expect(await failures()).toBe(0);
    expect(h.cookieSets).toHaveLength(0);
    expect((await login(db.pool, { username: "alice", password: PW, ip: "10.0.0.2", userAgent: "ua" })).ok).toBe(true); // still the old password
  });

  it("five wrong tries lock the change, as at sign-in (a stolen cookie cannot guess the password freely)", async () => {
    await makeOwner();
    const me = await signIn();
    h.session = me.id;
    for (let i = 0; i < 5; i++) await changePasswordAction({}, form({ current: `wrong password ${i}`, next: NEWPW, again: NEWPW }));
    const r = await changePasswordAction({}, form({ current: PW, next: NEWPW, again: NEWPW }));
    expect(r).toEqual({ ok: false, message: "Too many wrong tries. Wait a few minutes and try again." });
    expect(h.cookieSets).toHaveLength(0);
  });

  it("refuses a request from another origin or with no origin, before anything is read or changed", async () => {
    await makeOwner();
    const me = await signIn();
    h.session = me.id;
    for (const origin of ["https://evil.example", "null", ""]) {
      h.headers = new Headers({ ...(origin ? { origin } : {}), host: "localhost:3000" });
      const r = await changePasswordAction({}, form({ current: PW, next: NEWPW, again: NEWPW }));
      expect(r, origin).toEqual({ ok: false, message: "That request did not come from this page. Nothing was changed." });
    }
    expect(await failures()).toBe(0);
    expect((await login(db.pool, { username: "alice", password: PW, ip: "10.0.0.2", userAgent: "ua" })).ok).toBe(true);
  });

  it("is session-only: it asks requireOwner, which reads the cookie, and the file never reads an API token", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/settings/account/actions.ts", "utf8");
    expect(src.match(/await requireOwner\(\)/g)?.length).toBe(3); // each of the three actions
    expect(src).not.toMatch(/require-token|authorization|bearer/i);
  });
});

describe("signing sessions out", () => {
  it("signs out every other sign-in, keeps this one, audits the count, and says so in words", async () => {
    await makeOwner();
    const me = await signIn();
    const a = await signIn();
    const b = await signIn();
    h.session = me.id;
    expect(await signOutOthersAction()).toEqual({ ok: true, message: "Signed out 2 other sign-ins." });
    expect((await validateSession(db.pool, me.token)).ok).toBe(true);
    expect((await validateSession(db.pool, a.token)).ok).toBe(false);
    expect((await validateSession(db.pool, b.token)).ok).toBe(false);
    expect((await auditEvents("sessions.others_revoked"))[0]!.detail).toMatchObject({ count: 2, sessionId: me.id });
    expect(await signOutOthersAction()).toEqual({ ok: true, message: "There were no other sign-ins." });
  });
  it("signs out one other sign-in, refuses this one and a bad id, and never audits a token", async () => {
    await makeOwner();
    const me = await signIn();
    const other = await signIn();
    h.session = me.id;
    expect(await signOutSessionAction({}, form({ id: me.id }))).toEqual({ ok: false, message: "That is this sign-in. Use Sign out in the account menu." });
    expect(await signOutSessionAction({}, form({ id: "not-a-uuid" }))).toEqual({ ok: false, message: "That sign-in was not found." });
    expect(await signOutSessionAction({}, form({ id: "00000000-0000-4000-8000-000000000000" }))).toMatchObject({ ok: false });
    expect((await validateSession(db.pool, me.token)).ok).toBe(true);
    expect(await signOutSessionAction({}, form({ id: other.id }))).toEqual({ ok: true, message: "Signed out." });
    expect((await validateSession(db.pool, other.token)).ok).toBe(false);
    const a = JSON.stringify(await auditEvents("session.revoked"));
    expect(a).toContain(other.id);
    expect(a).not.toContain(other.token);
  });
  it("both refuse a foreign origin and change nothing", async () => {
    await makeOwner();
    const me = await signIn();
    const other = await signIn();
    h.session = me.id;
    h.headers = new Headers({ origin: "https://evil.example", host: "localhost:3000" });
    expect(await signOutOthersAction()).toMatchObject({ ok: false });
    expect(await signOutSessionAction({}, form({ id: other.id }))).toMatchObject({ ok: false });
    expect((await validateSession(db.pool, other.token)).ok).toBe(true);
  });
});
