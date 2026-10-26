import { chmodSync, copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = (script: string, env: Record<string, string>) =>
  spawnSync("npx", ["tsx", script], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", ...env }, encoding: "utf8" });
const dir = () => mkdtempSync(path.join(tmpdir(), "vault-"));
const tmp = () => path.join(dir(), ".env.local");
const KEY = "A".repeat(43) + "=";

describe("vault:init", () => {
  it("writes_key_0600_never_prints_it_appends_and_refuses_to_overwrite", () => {
    const f = tmp();
    writeFileSync(f, "OTHER=1", { mode: 0o644 });
    const r = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(r.status).toBe(0);
    const text = readFileSync(f, "utf8");
    const m = /^VAULT_MASTER_KEY=(\S{44})$/m.exec(text);
    expect(m).not.toBeNull();
    expect(text.startsWith("OTHER=1\n")).toBe(true); // appended after the existing bytes
    expect(r.stdout + r.stderr).not.toContain(m![1]!);
    expect(r.stdout).toMatch(/BACK IT UP/);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const again = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(again.status).toBe(1);
    expect(readFileSync(f, "utf8")).toBe(text);
    expect(again.stdout + again.stderr).not.toContain(m![1]!);
  });
  it("creates_a_new_file_0600", () => {
    const f = tmp();
    expect(run("scripts/vault-init.ts", { VAULT_ENV_FILE: f }).status).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it("tightens_a_loose_existing_file_before_appending", () => {
    const f = tmp();
    writeFileSync(f, "OTHER=1\n");
    chmodSync(f, 0o666);
    expect(run("scripts/vault-init.ts", { VAULT_ENV_FILE: f }).status).toBe(0);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it.each([
    ["empty", "VAULT_MASTER_KEY=\n"],
    ["export", `export VAULT_MASTER_KEY=${KEY}\n`],
    ["leading_spaces", `   VAULT_MASTER_KEY=${KEY}\n`],
    ["crlf", `A=1\r\nVAULT_MASTER_KEY=${KEY}\r\n`],
    ["colon", `VAULT_MASTER_KEY: ${KEY}\n`],
    ["space_before_equals", `VAULT_MASTER_KEY =${KEY}\n`],
  ])("refuses_when_env_local_defines_it_%s", (_n, body) => {
    const f = tmp();
    writeFileSync(f, body);
    const r = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(r.status).toBe(1);
    expect(readFileSync(f, "utf8")).toBe(body);
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
  it.each([".env", ".env.development.local", ".env.production.local"])("refuses_when_%s_defines_it", (name) => {
    const d = dir();
    writeFileSync(path.join(d, name), `VAULT_MASTER_KEY=${KEY}\n`);
    const f = path.join(d, ".env.local");
    const r = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f });
    expect(r.status).toBe(1);
    expect(() => statSync(f)).toThrow(); // nothing created
  });
  it("refuses_when_the_process_env_has_it", () => {
    const f = tmp();
    const r = run("scripts/vault-init.ts", { VAULT_ENV_FILE: f, VAULT_MASTER_KEY: KEY });
    expect(r.status).toBe(1);
    expect(() => statSync(f)).toThrow();
    expect(r.stdout + r.stderr).not.toContain(KEY);
  });
  it("commented_lines_and_the_previous_key_do_not_count", () => {
    const f = tmp();
    writeFileSync(f, `# VAULT_MASTER_KEY=${KEY}\n  # VAULT_MASTER_KEY: ${KEY}\nVAULT_MASTER_KEY_PREVIOUS=${KEY}\n`);
    expect(run("scripts/vault-init.ts", { VAULT_ENV_FILE: f }).status).toBe(0);
    expect(readFileSync(f, "utf8")).toMatch(/^VAULT_MASTER_KEY=\S{44}$/m);
  });
  it("works_after_cp_env_example_to_env_local", () => {
    const f = tmp();
    copyFileSync(".env.example", f);
    expect(run("scripts/vault-init.ts", { VAULT_ENV_FILE: f }).status).toBe(0);
    expect(readFileSync(f, "utf8")).toMatch(/^VAULT_MASTER_KEY=\S{44}$/m);
  });
});

describe("vault:check and vault:rotate", () => {
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
  it("check_fails_when_env_local_is_group_or_world_accessible", () => {
    const f = tmp();
    writeFileSync(f, "X=1\n");
    const key = Buffer.alloc(32, 7).toString("base64");
    for (const mode of [0o640, 0o604, 0o644]) {
      chmodSync(f, mode);
      const r = run("scripts/vault-check.ts", { VAULT_MASTER_KEY: key, VAULT_ENV_FILE: f });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/chmod 600/);
    }
    chmodSync(f, 0o600);
    expect(run("scripts/vault-check.ts", { VAULT_MASTER_KEY: key, VAULT_ENV_FILE: f }).status).toBe(0);
  });
  it("rotate_without_a_key_fails_cleanly", () => {
    const r = run("scripts/vault-rotate.ts", {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing_key/);
  });
  it("package_scripts_load_env_local_and_gitignore_covers_it", () => {
    const s = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(s["vault:check"]).toContain("--env-file-if-exists=.env.local");
    expect(s["vault:rotate"]).toContain("--env-file-if-exists=.env.local");
    expect(s["vault:init"]).toBe("tsx scripts/vault-init.ts");
    const ig = readFileSync(".gitignore", "utf8");
    expect(ig).toMatch(/^\.env\*$/m);
    expect(ig).not.toMatch(/^!\.env\.local/m);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^# VAULT_MASTER_KEY=$/m);
    expect(readFileSync(".env.example", "utf8")).not.toMatch(/^VAULT_MASTER_KEY=/m);
  });
});
