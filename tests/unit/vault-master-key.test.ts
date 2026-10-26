import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { loadKeyring, resetKeyringCacheForTests } from "@/server/db/master-key";

const key = () => randomBytes(32).toString("base64");
afterEach(() => {
  delete process.env.VAULT_MASTER_KEY;
  delete process.env.VAULT_MASTER_KEY_PREVIOUS;
  resetKeyringCacheForTests();
});

describe("loadKeyring from process.env", () => {
  it("removes_both_vars_from_process_env_and_caches_the_keyring", () => {
    process.env.VAULT_MASTER_KEY = key();
    process.env.VAULT_MASTER_KEY_PREVIOUS = key();
    const a = loadKeyring();
    expect(process.env.VAULT_MASTER_KEY).toBeUndefined();
    expect(process.env.VAULT_MASTER_KEY_PREVIOUS).toBeUndefined();
    expect("VAULT_MASTER_KEY" in process.env).toBe(false);
    expect(loadKeyring()).toBe(a); // second call: cached, env no longer needed
    expect(a.byId.size).toBe(2);
  });
  it("children_spawned_afterwards_do_not_inherit_the_key", () => {
    const k = key();
    process.env.VAULT_MASTER_KEY = k;
    loadKeyring();
    const out = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { encoding: "utf8" });
    expect(out).not.toContain("VAULT_MASTER_KEY");
  });
  it("a_failed_load_still_scrubs_and_does_not_cache", () => {
    process.env.VAULT_MASTER_KEY = "garbage";
    expect(() => loadKeyring()).toThrow();
    expect(process.env.VAULT_MASTER_KEY).toBeUndefined();
    process.env.VAULT_MASTER_KEY = key();
    expect(loadKeyring().current.id).toMatch(/^[0-9a-f]{8}$/);
  });
  it("an_injected_env_is_untouched_and_not_cached", () => {
    const env = { VAULT_MASTER_KEY: key() };
    const a = loadKeyring(env);
    expect(env.VAULT_MASTER_KEY).toBeDefined();
    expect(loadKeyring(env)).not.toBe(a);
  });
});

describe("client code may not import the vault", () => {
  const eslint = new ESLint();
  const errs = async (file: string, code: string) =>
    ((await eslint.lintText(code, { filePath: `${process.cwd()}/${file}` }))[0]?.messages ?? []).filter((m) => m.ruleId === "no-restricted-imports");
  it.each([
    ["src/ui/a.tsx", 'import { getSecret } from "@/server/db/vault";\nexport const a = getSecret;\n'],
    ["src/ui/a.tsx", 'import { loadKeyring } from "@/server/db/master-key";\nexport const a = loadKeyring;\n'],
    ["src/app/settings/key-row.tsx", 'import { getSecret } from "../../server/db/vault";\nexport const a = getSecret;\n'],
    ["src/app/settings/key-row.tsx", 'import { loadKeyring } from "@/server/db/master-key";\nexport const a = loadKeyring;\n'],
  ])("%s_importing_vault_is_error_%#", async (file, code) => {
    expect(await errs(file, code)).toHaveLength(1);
  });
  it.each([
    ["src/app/settings/actions.ts", 'import { getSecret } from "@/server/db/vault";\nexport const a = getSecret;\n'],
    ["src/app/settings/page.tsx", 'import { listSecrets } from "@/server/db/vault";\nexport const a = listSecrets;\n'],
    ["src/server/db/provider-keys.ts", 'import { getSecret } from "@/server/db/vault";\nexport const a = getSecret;\n'],
    ["src/ui/a.tsx", 'import { x } from "@/server/core/vault-crypto";\nexport const a = x;\n'],
  ])("%s_allowed_%#", async (file, code) => {
    expect(await errs(file, code)).toHaveLength(0);
  });
});
