import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSessionSettings } from "@/server/db/settings";
import { loadPolicies } from "@/server/db/system-settings";
import { withTestDb, type TestDb } from "../support/db";

let db: TestDb;
beforeAll(async () => {
  db = await withTestDb();
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.reset();
});

describe("loadPolicies (the read-only Policies page)", () => {
  it("starts in the safe state: evidence required, public off, kill switch off, not live", async () => {
    expect(await loadPolicies(db.pool)).toEqual({ requireEvidence: true, allowPublic: false, killSwitch: false, cutoverDone: false });
  });
  it("shows what is stored", async () => {
    await db.ownerPool.query(`insert into settings (key, value, updated_by) values ('policy.require_evidence', 'false'::jsonb, 'system'), ('policy.allow_public', 'true'::jsonb, 'system'), ('uploads.kill_switch', 'true'::jsonb, 'system'), ('youtube.cutover_done', 'true'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`);
    expect(await loadPolicies(db.pool)).toEqual({ requireEvidence: false, allowPublic: true, killSwitch: true, cutoverDone: true });
  });
  it("a stored value that is not a boolean reads as the SAFE default, never as 'off' or 'open'", async () => {
    await db.ownerPool.query(`insert into settings (key, value, updated_by) values ('policy.require_evidence', '"false"'::jsonb, 'system'), ('policy.allow_public', '"true"'::jsonb, 'system')
       on conflict (key) do update set value = excluded.value`);
    const p = await loadPolicies(db.pool);
    expect(p.requireEvidence).toBe(true);
    expect(p.allowPublic).toBe(false);
  });
});

describe("the page cannot change a policy", () => {
  it("the generic session writer still refuses both policy keys, so no page can write them", async () => {
    for (const key of ["policy.require_evidence", "policy.allow_public"]) {
      await expect(setSessionSettings(db.pool, [{ key, value: true }], async () => undefined), key).rejects.toThrow(/not writable here/);
    }
    expect((await db.pool.query("select count(*)::int n from settings where key like 'policy.%'")).rows[0].n).toBe(0);
  });
  it("the Policies page has no form, no input and no server action", () => {
    const dir = "src/app/(app)/settings/policies";
    const page = readFileSync(`${dir}/page.tsx`, "utf8");
    expect(page).not.toMatch(/<form|<input|<button|"use server"|action=/i);
    expect(page).not.toMatch(/setSetting|setSessionSettings|savePolic/);
  });
});
