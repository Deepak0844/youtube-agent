import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { SAFETY_KEYS, SETTINGS } from "@/server/core/settings-registry";
import { setSetting, type Actor } from "@/server/db/settings";
import { gateById } from "@/server/core/gates";
import { expectSessionRequired, expectTokenCannotPass, type GateAct } from "../support/gate-invariants";
import { SETTINGS_IMPORT_ALLOW, scanSettingsWrites } from "../support/settings-write-scan";

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

// The `allow_public` gate IS the safety setting policy.allow_public, so its gate-harness suite drives the real setSetting.
// (This setting has no content hash: the stale-hash and voided-by-change helpers do not apply and are not run.)
describe("allow_public gate (policy.allow_public) through the gate harness", () => {
  const act: GateAct = async ({ actor }) => {
    const client = { query: async () => ({ rows: [] }), release: () => {} };
    const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as pg.Pool;
    try {
      await setSetting(pool, "policy.allow_public", true, { actor: actor as Actor });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  };
  it("only a session passes the gate; a token, system, job or anonymous actor cannot", async () => {
    await expectSessionRequired(gateById("allow_public"), act);
    await expectTokenCannotPass(gateById("allow_public"), act);
  });
});

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
  const rel = (f: string) => path.relative(path.resolve("."), f).split(path.sep).join("/");

  it("real sources (TypeScript AST scan)", () => {
    const bad = walk(SRC)
      .filter((f) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(f))
      .flatMap((f) => scanSettingsWrites(rel(f), readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("the import allow-list is explicit (a new importer must be added here on purpose)", () => {
    // file -> the only names it may import. llm-models reads network.local_services (getSetting) and uses the Actor type.
    expect(SETTINGS_IMPORT_ALLOW).toEqual({
      "src/server/db/llm-models.ts": ["getSetting", "Actor"],
      "src/server/db/system-settings.ts": ["getSetting", "setSessionSettings"],
    });
    for (const names of Object.values(SETTINGS_IMPORT_ALLOW)) expect(names).not.toContain("setSetting");
  });

  const OK = 'import { setSetting } from "@/server/db/settings";\nawait setSetting(db, k, v, { actor: "session" });';
  const scan = (src: string, file = "src/app/x/actions.ts", allow: Record<string, readonly string[]> = { [file]: ["setSetting"] }) => scanSettingsWrites(file, src, allow);
  const IMP = 'import { setSetting } from "@/server/db/settings";\n';
  const NS = 'import * as s from "@/server/db/settings";\n';

  it("SELF-TEST: the plain session call in an allow-listed file is accepted", () => {
    expect(scan(OK)).toEqual([]);
  });

  describe("SELF-TEST: every bypass is flagged", () => {
    const bypasses: Record<string, string> = {
      "token actor": IMP + 'await setSetting(db, k, v, { actor: "token" });',
      "system actor": IMP + 'await setSetting(db, k, v, { actor: "system" });',
      "variable actor": IMP + "await setSetting(db, k, v, { actor });",
      "opts variable": IMP + "await setSetting(db, k, v, opts);",
      "type-cast actor": IMP + 'await setSetting(db, k, v, { actor: "token" as "session" });',
      "double cast actor": IMP + 'await setSetting(db, k, v, { actor: ("token" as string) as "session" });',
      "cast whole object": IMP + 'await setSetting(db, k, v, { actor: "token" } as { actor: "session" });',
      "extra property": IMP + 'await setSetting(db, k, v, { actor: "session", ...o });',
      "spread before": IMP + 'await setSetting(db, k, v, { ...o, actor: "session" });',
      "aliased import": 'import { setSetting as w } from "@/server/db/settings";\nawait w(db, k, v, { actor: "token" });',
      "alias const": IMP + 'const w = setSetting;\nawait w(db, k, v, { actor: "token" });',
      ".call": NS + 'await s.setSetting.call(null, db, k, v, { actor: "token" });',
      ".apply": IMP + 'await setSetting.apply(null, [db, k, v, { actor: "token" }]);',
      "element access": NS + 'await s["setSetting"](db, k, v, { actor: "token" });',
      "destructure rename": NS + "const { setSetting: w } = s;",
      "dynamic import": 'const m = await import("@/server/db/settings");\nawait m.setSetting(db, k, v, { actor: "token" });',
      require: 'const m = require("@/server/db/settings");',
      "export from": 'export { setSetting } from "@/server/db/settings";',
      "export star": 'export * from "@/server/db/settings";',
    };
    for (const [name, src] of Object.entries(bypasses)) {
      it(name, () => expect(scan(src), name).not.toEqual([]));
    }
    it("a relative import of db/settings from an unlisted file is flagged", () => {
      expect(scan('import { setSetting } from "../../server/db/settings";', "src/app/x/actions.ts", {})).not.toEqual([]);
      expect(scan('import { getSetting } from "./settings";', "src/server/db/other.ts", {})).not.toEqual([]);
    });
    it("an importer that is not on the allow-list is flagged even with a correct call", () => {
      expect(scan(OK, "src/app/x/actions.ts", {})).not.toEqual([]);
    });
    it("a mention in a comment or an unrelated string is not a call", () => {
      expect(scan('// setSetting(db,k,v,{actor:"token"})\nconst s = "setSetting";', "src/lib/a.ts", {})).toEqual([]);
    });
  });

  describe("SELF-TEST: an allowed file may import only its permitted names", () => {
    const F = "src/server/db/llm-models.ts";
    const allow = { [F]: ["getSetting", "Actor"] };
    const at = (src: string) => scanSettingsWrites(F, src, allow);
    it("permitted names pass, aliases of permitted names too", () => {
      expect(at('import { getSetting, type Actor } from "@/server/db/settings";')).toEqual([]);
      expect(at('import { getSetting as g } from "@/server/db/settings";')).toEqual([]);
    });
    it("an allowed file importing setSetting is flagged (even with a correct call)", () => {
      expect(at('import { getSetting, setSetting } from "@/server/db/settings";\nawait setSetting(db, k, v, { actor: "session" });')).not.toEqual([]);
    });
    it("any other name, default, namespace, side-effect import or re-export is flagged", () => {
      for (const src of [
        'import { SETTINGS } from "@/server/db/settings";',
        'import d from "@/server/db/settings";',
        'import * as s from "@/server/db/settings";',
        'import "@/server/db/settings";',
        'import { getSetting } from "@/server/db/settings";\nexport { getSetting } from "@/server/db/settings";',
        'import { setSetting as getSetting } from "@/server/db/settings";',
      ]) expect(at(src), src).not.toEqual([]);
    });
    it("an inherited object key is not an allow-list entry", () => {
      expect(scanSettingsWrites("constructor", 'import { getSetting } from "@/server/db/settings";', {})).not.toEqual([]);
    });
  });

  describe("SELF-TEST: SQL on the settings table outside settings.ts is flagged", () => {
    const sql: Record<string, string> = {
      plain: 'db.query("update settings set value = 1")',
      insert: "db.query(`insert into settings (key) values ($1)`)",
      "public schema": 'db.query("update public.settings set value = 1")',
      quoted: "db.query('update \"settings\" set value = 1')",
      "quoted schema": "db.query('update \"public\".\"settings\" set value = 1')",
      ONLY: 'db.query("UPDATE ONLY settings SET value = 1")',
      "upper case": 'db.query("DELETE FROM SETTINGS")',
      truncate: 'db.query("truncate table settings")',
      newline: 'db.query("update\\n  settings set value = 1")',
      "string built": 'const t = "settings"; db.query("update " + t + " set value = 1")',
      "concat literals": 'db.query("update " + "sett" + "ings set value = 1")',
      "template with expr": "db.query(`update ${schema}.settings set value = 1`)",
      "select (read)": 'db.query("select value from settings")',
    };
    for (const [name, src] of Object.entries(sql)) {
      it(name, () => expect(scanSettingsWrites("src/server/db/other.ts", src, {}), name).not.toEqual([]));
    }
    it("settings.ts itself and unrelated words are not flagged", () => {
      expect(scanSettingsWrites("src/server/db/settings.ts", 'db.query("update settings set value = 1")', {})).toEqual([]);
      expect(scanSettingsWrites("src/ui/nav.ts", 'const label = "Settings"; const href = "/settings/keys";', {})).toEqual([]);
      expect(scanSettingsWrites("src/x.ts", 'db.query("select * from user_settings_cache")', {})).toEqual([]);
    });
  });
});
