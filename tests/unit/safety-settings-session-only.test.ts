import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { SAFETY_KEYS, SETTINGS } from "@/server/core/settings-registry";
import { setSetting, type Actor } from "@/server/db/settings";
import { blank } from "../support/route-guards";

// Doc 02 4.6 / Doc 07: safety settings (policy.require_evidence, policy.allow_public, network.local_services, ...) can be
// changed ONLY by a logged-in session, never by an API token, the system or a job. This is also the suite for the
// `allow_public` gate in tests/support/gate-invariants.ts (its flag is the safety setting policy.allow_public).
// The database-level twin lives in tests/integration/safety-settings-session-only.test.ts.

// A pool that fails loudly on any use: the refusal must happen BEFORE the database is touched.
function untouchablePool(): { pool: pg.Pool; touched: () => number } {
  let n = 0;
  const boom = () => {
    n++;
    throw new Error("DB TOUCHED");
  };
  return { pool: { connect: boom, query: boom } as unknown as pg.Pool, touched: () => n };
}

// Every non-session actor we can think of, including near-misses of "session" and a missing actor.
const NOT_SESSION = ["token", "system", "job", "worker", "anonymous", "SESSION", "session ", " session", "sessionx", "", undefined, null];

describe("the registry's safety keys", () => {
  it("cannot be silently demoted: the keys Doc 02 names stay safety", () => {
    for (const k of ["policy.require_evidence", "policy.allow_public", "network.local_services"]) {
      expect(SAFETY_KEYS as string[], `${k} must stay a safety key`).toContain(k);
    }
  });
  it("SAFETY_KEYS is exactly the registry rows marked safety", () => {
    expect([...SAFETY_KEYS].sort()).toEqual(
      Object.entries(SETTINGS)
        .filter(([, d]) => d.safety)
        .map(([k]) => k)
        .sort(),
    );
  });
});

describe("setSetting refuses every non-session actor on every safety key", () => {
  for (const key of SAFETY_KEYS) {
    it(`${key}`, async () => {
      for (const actor of NOT_SESSION) {
        const { pool, touched } = untouchablePool();
        // a VALID value, so the refusal can only be about the actor
        await expect(setSetting(pool, key, SETTINGS[key].default, { actor: actor as Actor }), `${key} / ${String(actor)}`).rejects.toThrow(/logged-in session/);
        expect(touched(), `${key} / ${String(actor)}: database touched before the refusal`).toBe(0);
      }
      await expect(setSetting(untouchablePool().pool, key, SETTINGS[key].default, undefined as never)).rejects.toThrow();
    });
  }
});

describe("no code path in src writes a safety setting as anything but a session", () => {
  const SRC = path.resolve("src");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n)) : [path.join(d, n)]));
  const SETTINGS_DB = path.join(SRC, "server/db/settings.ts");

  /** Problems in one source file: a setSetting call not passing the literal session actor, or raw SQL writing `settings`. */
  function problems(src: string, file: string): string[] {
    const out: string[] = [];
    const code = blank(src, true); // comments gone, strings kept
    for (let i = code.indexOf("setSetting("); i >= 0; i = code.indexOf("setSetting(", i + 1)) {
      if (/\b(?:function|import)\b[^\n]*$/.test(code.slice(Math.max(0, i - 60), i))) continue; // declaration / import line
      const head = code.slice(i, i + 400);
      let depth = 0;
      let end = head.length;
      for (let j = head.indexOf("("); j < head.length; j++) {
        if (head[j] === "(") depth++;
        else if (head[j] === ")" && --depth === 0) {
          end = j;
          break;
        }
      }
      if (!/\{\s*actor:\s*["']session["']\s*\}\s*$/.test(head.slice(0, end))) out.push(`${file}: setSetting call without the literal { actor: "session" }`);
    }
    if (/\b(?:insert\s+into|update|delete\s+from)\s+settings\b/i.test(code)) out.push(`${file}: raw SQL writes the settings table (bypasses the session-only rule)`);
    return out;
  }

  it("real sources", () => {
    const bad = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && f !== SETTINGS_DB)
      .flatMap((f) => problems(readFileSync(f, "utf8"), path.relative(SRC, f)));
    expect(bad).toEqual([]);
  });

  it("SELF-TEST: the checker flags token/system actors, a variable actor and raw SQL, and accepts a session call", () => {
    expect(problems('await setSetting(db, "policy.allow_public", true, { actor: "token" });', "a.ts")).not.toEqual([]);
    expect(problems('await setSetting(db, k, v, { actor: "system" });', "a.ts")).not.toEqual([]);
    expect(problems("await setSetting(db, k, v, { actor });", "a.ts")).not.toEqual([]);
    expect(problems("await setSetting(db, k, v, opts);", "a.ts")).not.toEqual([]);
    expect(problems("await db.query(`update settings set value = $1`)", "a.ts")).not.toEqual([]);
    expect(problems('// setSetting(db, k, v, { actor: "token" })\nconst x = 1;', "a.ts")).toEqual([]);
    expect(problems('await setSetting(db, "policy.allow_public", true, { actor: "session" });', "a.ts")).toEqual([]);
  });
});
