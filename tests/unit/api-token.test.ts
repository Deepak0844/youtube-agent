import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateToken, hashesEqual, hashToken, MAX_DAILY_CAP, parseBearer, parseNewToken, TOKEN_SCOPES } from "@/server/core/api-token";
import { SAFETY_KEYS } from "@/server/core/settings-registry";
import { redactDetail } from "@/server/core/audit-events";

describe("token format and hashing", () => {
  it("generates a 47-char secret, a 12-char prefix, and a 32-byte hash of that secret", () => {
    const t = generateToken();
    expect(t.secret).toMatch(/^yts_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.secret.slice(0, 12));
    expect(t.hash).toHaveLength(32);
    expect(t.hash.equals(hashToken(t.secret))).toBe(true);
    expect(t.hash.toString("utf8")).not.toContain(t.secret);
  });
  it("two tokens differ", () => expect(generateToken().secret).not.toBe(generateToken().secret));
  it("compares with timingSafeEqual and never throws on a length mismatch", async () => {
    const a = hashToken("x");
    expect(hashesEqual(a, hashToken("x"))).toBe(true);
    expect(hashesEqual(a, hashToken("y"))).toBe(false);
    expect(hashesEqual(a, Buffer.alloc(5))).toBe(false);
    expect(hashesEqual(a, Buffer.alloc(0))).toBe(false);
    const src = readFileSync("src/server/core/api-token.ts", "utf8");
    expect(src).toContain("timingSafeEqual(a, b)");
    const db = readFileSync("src/server/db/api-tokens.ts", "utf8");
    expect(db).toContain("hashesEqual(presented"); // never `===`/`=` on a hash or a secret, never `token_hash = $1`
    expect(db).not.toMatch(/where[^`"]*token_hash\s*=/i);
  });
});

describe("parseBearer", () => {
  const good = generateToken().secret;
  it("accepts Bearer <token> (scheme case-insensitive)", () => {
    expect(parseBearer(`Bearer ${good}`)).toBe(good);
    expect(parseBearer(`bearer ${good}`)).toBe(good);
  });
  it.each([null, undefined, "", "Bearer", "Bearer ", `Basic ${good}`, good, `Bearer  ${good}`, `Bearer ${good} x`, `Bearer ${good}\n`, "Bearer yts_short", `Bearer ${good}A`, `Bearer ${"a".repeat(500)}`, "Bearer sk-live-123"])("rejects %j", (h) => {
    expect(parseBearer(h)).toBeNull();
  });
});

describe("parseNewToken", () => {
  const ok = { name: " Phone ", scopes: ["read", "create_draft", "read"], cap: "5" };
  it("accepts and normalises", () => expect(parseNewToken(ok)).toEqual({ ok: true, value: { name: "Phone", scopes: ["read", "create_draft"], dailyDraftCap: 5 } }));
  it("allows a read-only token with cap 0", () => expect(parseNewToken({ ...ok, scopes: ["read"], cap: "0" }).ok).toBe(true));
  it.each([
    [{ ...ok, name: "" }],
    [{ ...ok, name: "x".repeat(61) }],
    [{ ...ok, name: 5 }],
    [{ ...ok, scopes: [] }],
    [{ ...ok, scopes: ["read", "approve_gate"] }],
    [{ ...ok, scopes: ["admin"] }],
    [{ ...ok, scopes: [{}] }],
    [{ ...ok, cap: "-1" }],
    [{ ...ok, cap: String(MAX_DAILY_CAP + 1) }],
    [{ ...ok, cap: "1.5" }],
    [{ ...ok, cap: "abc" }],
    [{ ...ok, cap: null }],
    [{ ...ok, cap: "0" }], // create_draft with cap 0
  ])("rejects %j", (raw) => expect(parseNewToken(raw).ok).toBe(false));
});

describe("hard rules: what a token can never do", () => {
  it("has exactly two scopes, none about gates, settings, keys or tokens", () => {
    expect([...TOKEN_SCOPES]).toEqual(["read", "create_draft"]);
  });
  it("no scope name collides with a safety setting key", () => {
    for (const k of SAFETY_KEYS) for (const s of TOKEN_SCOPES) expect(k).not.toContain(s);
  });

  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
  const src = walk("src").filter((f) => /\.(ts|tsx)$/.test(f));
  const text = (f: string) => readFileSync(f, "utf8");
  const norm = (f: string) => f.split(path.sep).join("/");

  it("only /api/v1 routes (and the token door itself) import the token door or the token authenticator", () => {
    const allowed = (f: string) => norm(f).startsWith("src/app/api/v1/") || ["src/lib/auth/require-token.ts", "src/server/db/api-tokens.ts", "src/server/core/api-token.ts"].includes(norm(f));
    for (const f of src) {
      if (allowed(f)) continue;
      const t = text(f);
      expect(t, f).not.toMatch(/require-token|authenticateToken|createDraftForToken|parseBearer|requireTokenApi/);
    }
  });
  it("the /api/v1 routes never import gates, approvals, settings, vault, keys, publish or token management", () => {
    const routes = src.filter((f) => norm(f).startsWith("src/app/api/v1/"));
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const f of routes) {
      const imports = [...text(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const i of imports) expect(i, `${f}: ${i}`).not.toMatch(/approval|gate|settings|vault|secret|master-key|provider-keys|publish|upload|google|owner|auth\/session|decision|breaker/i);
    }
  });
  it("the token door never reads cookies and the session door never reads Authorization", () => {
    expect(text("src/lib/auth/require-token.ts")).not.toMatch(/readSessionCookie|get\(\s*["']cookie["']/i);
    expect(text("src/lib/auth/require-owner.ts")).not.toMatch(/authorization|bearer/i);
    expect(text("src/proxy.ts")).not.toMatch(/authorization|bearer/i);
  });
  it("the tokens page actions authenticate with the session only", () => {
    const a = text("src/app/(app)/settings/tokens/actions.ts");
    expect(a.match(/await requireOwner\(\)/g)?.length).toBe(2);
    expect(a).not.toMatch(/require-token|authorization/i);
  });
  it("no source outside /api/v1 and tokens code reads the Authorization header", () => {
    for (const f of src) {
      const n = norm(f);
      if (n.startsWith("src/app/api/v1/") || n === "src/lib/auth/require-token.ts" || n === "src/server/core/api-token.ts") continue;
      if (/headers\.get\(\s*["']authorization["']\s*\)/i.test(text(f))) {
        // other callers send their own provider Authorization headers; none may be an inbound request read
        expect(text(f), f).not.toMatch(/request\.headers\.get\(\s*["']authorization["']/i);
      }
    }
  });
});

describe("audit redaction keeps the secret out", () => {
  it("blanks a leaked secret value even under an innocent key", () => {
    const { secret } = generateToken();
    const r = redactDetail({ ref: "x", note: secret });
    expect(JSON.stringify(r.safe)).not.toContain(secret);
  });
});
