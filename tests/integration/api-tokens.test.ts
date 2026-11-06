import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as statusGet } from "@/app/api/v1/status/route";
import { POST as draftsPost } from "@/app/api/v1/drafts/route";
import { GET as meGet } from "@/app/api/me/route";
import { generateToken } from "@/server/core/api-token";
import { authenticateToken, createApiToken, createDraftForToken, listApiTokens, revokeApiToken } from "@/server/db/api-tokens";
import { recordAudit } from "@/server/db/audit";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
  (globalThis as Record<symbol, unknown>)[Symbol.for("ytstudio.pool")] = db.pool;
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

const BASE = "http://localhost:3000";
const bearer = (s: string) => ({ authorization: `Bearer ${s}`, host: "localhost:3000" });
const get = (path: string, headers: Record<string, string>) => new Request(BASE + path, { headers });
const post = (path: string, headers: Record<string, string>, body: unknown) =>
  new Request(BASE + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const mk = (over: Partial<{ name: string; scopes: ("read" | "create_draft")[]; dailyDraftCap: number }> = {}) =>
  createApiToken(db.pool, { name: "t", scopes: ["read", "create_draft"], dailyDraftCap: 2, ...over });
const videoCount = async () => Number((await db.ownerPool.query("select count(*)::int n from videos")).rows[0].n);

describe("storage", () => {
  it("stores only a hash, never the secret", async () => {
    const t = await mk();
    const row = (await db.ownerPool.query("select * from api_tokens")).rows[0];
    expect(JSON.stringify(row)).not.toContain(t.secret);
    expect(Buffer.from(row.token_hash).equals(generateToken().hash)).toBe(false);
    expect(row.prefix).toBe(t.secret.slice(0, 12));
    expect(Object.keys(row)).not.toContain("secret");
    const all = await db.ownerPool.query("select t::text from api_tokens t");
    expect(all.rows[0].t).not.toContain(t.secret.slice(12));
  });
  it("the database refuses unknown scopes, empty scopes and a huge cap", async () => {
    const h = generateToken();
    const ins = (scopes: string[], cap = 1) => db.ownerPool.query("insert into api_tokens (name, prefix, token_hash, scopes, daily_draft_cap) values ('x',$1,$2,$3,$4)", [h.prefix, h.hash, scopes, cap]);
    await expect(ins(["approve_gate"])).rejects.toMatchObject({ code: "23514" });
    await expect(ins([])).rejects.toMatchObject({ code: "23514" });
    await expect(ins(["read"], 101)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("/api/v1 bearer auth (adversarial)", () => {
  it("a valid token with read scope sees status", async () => {
    const t = await mk();
    const r = await statusGet(get("/api/v1/status", bearer(t.secret)));
    expect(r.status).toBe(200);
    const row = (await listApiTokens(db.pool))[0]!;
    expect(row.lastUsedAt).not.toBeNull();
  });
  it("no header, wrong token, unknown token with a real prefix, truncated token, and a cookie-only request all get 401", async () => {
    const t = await mk();
    const wrongSameLen = t.secret.slice(0, -1) + (t.secret.endsWith("A") ? "B" : "A");
    const samePrefix = t.secret.slice(0, 12) + "x".repeat(35);
    for (const h of <Record<string, string>[]>[{ host: "localhost:3000" }, bearer(wrongSameLen), bearer(samePrefix), bearer(t.secret.slice(0, 20)), bearer(generateToken().secret), { host: "localhost:3000", cookie: "ytstudio_session=abc" }, { host: "localhost:3000", authorization: `Basic ${t.secret}` }, { host: "localhost:3000", authorization: t.secret }]) {
      const r = await statusGet(get("/api/v1/status", h));
      expect(r.status, JSON.stringify(h)).toBe(401);
      expect(JSON.stringify(await r.json())).not.toContain(t.secret);
    }
  });
  it("the token in the query string or body is ignored", async () => {
    const t = await mk();
    expect((await statusGet(get(`/api/v1/status?token=${t.secret}&access_token=${t.secret}`, { host: "localhost:3000" }))).status).toBe(401);
  });
  it("a revoked token is refused at once, on every route", async () => {
    const t = await mk();
    expect((await statusGet(get("/api/v1/status", bearer(t.secret)))).status).toBe(200);
    expect(await revokeApiToken(db.pool, t.id)).not.toBeNull();
    expect((await statusGet(get("/api/v1/status", bearer(t.secret)))).status).toBe(401);
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "x" }))).status).toBe(401);
    expect(await videoCount()).toBe(0);
    expect(await revokeApiToken(db.pool, t.id)).toBeNull(); // second revoke is a no-op
    expect(await authenticateToken(db.pool, t.secret)).toBeNull();
  });
  it("a token missing the scope gets 403 and creates nothing", async () => {
    const ro = await mk({ scopes: ["read"] });
    const r = await draftsPost(post("/api/v1/drafts", bearer(ro.secret), { topic: "x" }));
    expect(r.status).toBe(403);
    const dr = await mk({ scopes: ["create_draft"] });
    expect((await statusGet(get("/api/v1/status", bearer(dr.secret)))).status).toBe(403);
    expect(await videoCount()).toBe(0);
  });
  it("a bad Host is refused before the token is looked at", async () => {
    const t = await mk();
    const r = await statusGet(get("/api/v1/status", { authorization: `Bearer ${t.secret}`, host: "evil.example" }));
    expect(r.status).toBe(403);
  });
});

describe("a token can never reach the owner side", () => {
  it("a valid bearer token does not open the session-only API", async () => {
    const t = await mk();
    expect((await meGet(get("/api/me", bearer(t.secret)))).status).toBe(401);
  });
  it("there is no /api/v1 route for gates, approvals, settings, keys or tokens", async () => {
    const { routeTable } = await import("../support/route-table");
    const v1 = routeTable().filter((r) => r.url.startsWith("/api/v1")).map((r) => r.url);
    expect(v1.sort()).toEqual(["/api/v1/drafts", "/api/v1/status"]);
  });
  it("creating a draft changes no setting, writes no approval, queues no job and keeps the draft unapproved", async () => {
    const t = await mk();
    const before = {
      settings: JSON.stringify((await db.ownerPool.query("select key, value from settings order by key")).rows),
      approvals: (await db.ownerPool.query("select count(*)::int n from approvals")).rows[0].n,
      secrets: (await db.ownerPool.query("select count(*)::int n from secrets")).rows[0].n,
    };
    const r = await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "A topic", notes: "n", format: "long", status: "done", approved: true, visibility: "public" }));
    expect(r.status).toBe(201);
    const v = (await db.ownerPool.query("select format, status, kind from videos")).rows[0];
    expect(v).toMatchObject({ format: "short", status: "active" }); // body fields beyond topic/notes are ignored
    expect(JSON.stringify((await db.ownerPool.query("select key, value from settings order by key")).rows)).toBe(before.settings);
    expect((await db.ownerPool.query("select count(*)::int n from approvals")).rows[0].n).toBe(before.approvals);
    expect((await db.ownerPool.query("select count(*)::int n from secrets")).rows[0].n).toBe(before.secrets);
  });
});

describe("daily draft cap (IST day)", () => {
  it("allows exactly the cap, then 429, and rolls nothing back into videos", async () => {
    const t = await mk({ dailyDraftCap: 2 });
    for (let i = 0; i < 2; i++) expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: `v${i}` }))).status).toBe(201);
    const r = await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "v3" }));
    expect(r.status).toBe(429);
    expect(await videoCount()).toBe(2);
    expect((await listApiTokens(db.pool))[0]!.draftsToday).toBe(2);
  });
  it("parallel requests cannot pass the cap", async () => {
    const t = await mk({ dailyDraftCap: 3 });
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: `p${i}` }))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(9);
    expect(await videoCount()).toBe(3);
  });
  it("the cap is per token", async () => {
    const a = await mk({ dailyDraftCap: 1 });
    const b = await mk({ dailyDraftCap: 1 });
    expect((await draftsPost(post("/api/v1/drafts", bearer(a.secret), { topic: "a" }))).status).toBe(201);
    expect((await draftsPost(post("/api/v1/drafts", bearer(a.secret), { topic: "a2" }))).status).toBe(429);
    expect((await draftsPost(post("/api/v1/drafts", bearer(b.secret), { topic: "b" }))).status).toBe(201);
  });
  it("counts the IST day, not the UTC day: yesterday's usage (IST) does not count today", async () => {
    const t = await mk({ dailyDraftCap: 1 });
    await db.ownerPool.query("insert into api_token_usage (token_id, day, drafts) values ($1, (now() at time zone 'Asia/Kolkata')::date - 1, 1)", [t.id]);
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "today" }))).status).toBe(201);
    const today = (await db.ownerPool.query("select ((now() at time zone 'Asia/Kolkata')::date)::text d")).rows[0].d;
    expect((await db.ownerPool.query("select day::text d from api_token_usage where token_id=$1 order by day", [t.id])).rows.map((r) => r.d).pop()).toBe(today);
  });
  it("a token revoked after authenticating still creates nothing", async () => {
    const t = await mk();
    const authed = (await authenticateToken(db.pool, t.secret))!;
    await revokeApiToken(db.pool, t.id);
    expect(await createDraftForToken(db.pool, authed, { topic: "late" })).toEqual({ ok: false, reason: "cap_reached" });
    expect(await videoCount()).toBe(0);
  });
  it("cap 0 creates nothing even if the scope were present", async () => {
    const t = await mk({ scopes: ["read", "create_draft"], dailyDraftCap: 0 });
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "x" }))).status).toBe(429);
  });
  it("bad bodies are 400 and use no quota", async () => {
    const t = await mk({ dailyDraftCap: 1 });
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "" }))).status).toBe(400);
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "x".repeat(201) }))).status).toBe(400);
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: 5 }))).status).toBe(400);
    expect((await draftsPost(new Request(BASE + "/api/v1/drafts", { method: "POST", headers: bearer(t.secret), body: "{nope" }))).status).toBe(400);
    expect((await draftsPost(post("/api/v1/drafts", bearer(t.secret), { topic: "ok" }))).status).toBe(201);
  });
});

describe("audit", () => {
  it("accepts the create and revoke events and a detail without the secret", async () => {
    const t = await mk();
    await recordAudit(db.pool, "api_token.created", { ref: t.id, name: "t", prefix: t.prefix, scopes: ["read"] });
    await recordAudit(db.pool, "api_token.revoked", { ref: t.id, name: "t", prefix: t.prefix });
    const rows = (await db.ownerPool.query("select event, detail::text d from audit_log order by id")).rows;
    expect(rows.map((r) => r.event)).toEqual(["api_token.created", "api_token.revoked"]);
    for (const r of rows) expect(r.d).not.toContain(t.secret);
  });
});
