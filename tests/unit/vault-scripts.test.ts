import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (script: string, env: Record<string, string>) =>
  spawnSync("npx", ["tsx", script], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", ...env }, encoding: "utf8" });
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "vault-")), ".env.local");

describe("vault scripts", () => {
  it("init_writes_key_0600_never_prints_it_and_refuses_to_overwrite", () => {
    const f = tmp();
    writeFileSync(f, "OTHER=1", { mode: 0o644 });
    const r = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(r.status).toBe(0);
    const text = readFileSync(f, "utf8");
    const m = /^VAULT_MASTER_KEY=(\S{44})$/m.exec(text);
    expect(m).not.toBeNull();
    expect(text.startsWith("OTHER=1\n")).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(m![1]!);
    expect(r.stdout).toMatch(/BACK IT UP/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const again = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(again.status).toBe(1);
    expect(readFileSync(f, "utf8")).toBe(text);
    expect(again.stdout + again.stderr).not.toContain(m![1]!);
  });
  it("init_refuses_even_an_empty_existing_entry", () => {
    const f = tmp();
    writeFileSync(f, "VAULT_MASTER_KEY=\n");
    expect(run("scripts/vault-init.ts", { VAULT_ENV_FILE: f }).status).toBe(1);
    expect(readFileSync(f, "utf8")).toBe("VAULT_MASTER_KEY=\n");
  });
  it("check_reports_missing_key_and_ok_without_leaking", () => {
    const miss = run("scripts/vault-check.ts", {});
    expect(miss.status).toBe(1);
    expect(miss.stderr).toMatch(/missing_key/);
    const key = Buffer.alloc(32, 7).toString("base64");
    const ok = run("scripts/vault-check.ts", { VAULT_MASTER_KEY: key });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^ok/);
    expect(ok.stdout + ok.stderr).not.toContain(key);
  });
  it("package_scripts_load_env_local_and_gitignore_covers_it", () => {
    const s = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(s["vault:check"]).toContain("--env-file-if-exists=.env.local");
    expect(s["vault:init"]).toBe("tsx scripts/vault-init.ts");
    const ig = readFileSync(".gitignore", "utf8");
    expect(ig).toMatch(/^\.env\*$/m);
    expect(ig).not.toMatch(/^!\.env\.local/m);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^VAULT_MASTER_KEY=$/m);
  });
});
