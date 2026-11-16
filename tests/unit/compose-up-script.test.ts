import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Runs scripts/compose-up.ts for real in dry-run mode (writes .env and the data folder, starts no Docker).
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(dir: string) {
  return spawnSync("npx", ["tsx", "scripts/compose-up.ts"], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", COMPOSE_UP_DRY_RUN: "1", COMPOSE_ENV_FILE: path.join(dir, ".env"), COMPOSE_DATA_DIR: path.join(dir, "data") },
    encoding: "utf8",
  });
}
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), "compose-up-")); dirs.push(d); return d; };

describe("scripts/compose-up.ts", () => {
  it("writes .env with mode 600 and the data folder when missing", () => {
    const dir = tmp();
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Wrote .env with new secrets");
    const file = path.join(dir, ".env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toMatch(/^POSTGRES_PASSWORD=\S{32}$/m);
    expect(readFileSync(file, "utf8")).toContain(`HOST_STORAGE_ROOT=${path.join(dir, "data")}`);
    expect(existsSync(path.join(dir, "data"))).toBe(true);
  });
  it("adds only the keys a newer version needs to an older .env (backup password, render token), leaving every other line alone", () => {
    const dir = tmp();
    const file = path.join(dir, ".env");
    writeFileSync(file, "POSTGRES_PASSWORD=mine\nVAULT_MASTER_KEY=keep\n", { mode: 0o600 });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Added YTSTUDIO_BACKUP_PASSWORD");
    expect(r.stdout).toContain("Added RENDER_RUNNER_TOKEN");
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("POSTGRES_PASSWORD=mine\nVAULT_MASTER_KEY=keep\n")).toBe(true);
    expect(text).toMatch(/^YTSTUDIO_BACKUP_PASSWORD=\S{32}$/m);
    expect(text).toMatch(/^RENDER_RUNNER_TOKEN=[A-Za-z0-9_-]{32}$/m);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run(dir).stdout).not.toContain("Added"); // second run: nothing to add
  });
  it("never overwrites an existing .env", () => {
    const dir = tmp();
    const file = path.join(dir, ".env");
    writeFileSync(file, "POSTGRES_PASSWORD=mine\nYTSTUDIO_BACKUP_PASSWORD=mine2\nRENDER_RUNNER_TOKEN=mine3\n", { mode: 0o600 });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Using existing .env");
    expect(readFileSync(file, "utf8")).toBe("POSTGRES_PASSWORD=mine\nYTSTUDIO_BACKUP_PASSWORD=mine2\nRENDER_RUNNER_TOKEN=mine3\n");
  });
});
