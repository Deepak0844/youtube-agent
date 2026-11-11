import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setSessionSettings } from "@/server/db/settings";
import { PUBLIC_PHRASE } from "@/server/core/channel-safety";
import { loadPolicies, saveUploadSwitches } from "@/server/db/system-settings";
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

describe("the public switch (the only policy a page can change)", () => {
  const audit = async () => (await db.pool.query("select count(*)::int n from audit_log where event = 'setting.changed' and detail->>'setting' = 'policy.allow_public'")).rows[0].n as number;
  it("turning it on without the exact phrase is refused and saves nothing", async () => {
    for (const typed of [undefined, "", "allow public", "ALLOW PUBLIC ", "GO LIVE"]) {
      const r = await saveUploadSwitches(db.pool, { allowPublic: true, typedPublic: typed });
      expect(r.ok, String(typed)).toBe(false);
    }
    expect((await loadPolicies(db.pool)).allowPublic).toBe(false);
    expect(await audit()).toBe(0);
  });
  it("the exact phrase turns it on (audited); turning it off needs no phrase", async () => {
    expect((await saveUploadSwitches(db.pool, { allowPublic: true, typedPublic: PUBLIC_PHRASE })).ok).toBe(true);
    expect((await loadPolicies(db.pool)).allowPublic).toBe(true);
    expect(await audit()).toBe(1);
    expect((await saveUploadSwitches(db.pool, { allowPublic: false })).ok).toBe(true);
    expect((await loadPolicies(db.pool)).allowPublic).toBe(false);
    expect(await audit()).toBe(2);
  });
  it("it never touches the evidence rule, the kill switch or the cutover", async () => {
    await saveUploadSwitches(db.pool, { allowPublic: true, typedPublic: PUBLIC_PHRASE });
    expect(await loadPolicies(db.pool)).toEqual({ requireEvidence: true, allowPublic: true, killSwitch: false, cutoverDone: false });
  });
});

describe("what a page cannot change", () => {
  it("no page can write the evidence rule: the session writer refuses it", async () => {
    await expect(setSessionSettings(db.pool, [{ key: "policy.require_evidence", value: false }], async () => undefined)).rejects.toThrow(/not writable here/);
    expect((await loadPolicies(db.pool)).requireEvidence).toBe(true);
  });
  it("the Policies folder has exactly one form, one action, and no writer for the evidence rule", () => {
    const dir = "src/app/(app)/settings/policies";
    const page = readFileSync(`${dir}/page.tsx`, "utf8");
    const actions = readFileSync(`${dir}/actions.ts`, "utf8");
    expect(page).not.toMatch(/<form|"use server"|setSetting|setSessionSettings/);
    expect(actions.match(/export async function/g)).toHaveLength(1);
    expect(actions).toMatch(/await requireOwner\(\);/);
    expect(actions).not.toMatch(/requireEvidence|require_evidence|setSetting|setSessionSettings/);
  });
});
