import { existsSync, statSync } from "node:fs";
import { getMigratePool, getPool } from "@/server/db/pool";
import { encryptSecret, decryptSecret, type Keyring } from "@/server/core/vault-crypto";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus } from "@/server/db/vault";

// Prints ok | missing_key | wrong_key | unreadable (+ names). Never prints key material or secret values.
async function main(): Promise<void> {
  const envFile = process.env.VAULT_ENV_FILE || ".env.local";
  if (existsSync(envFile) && (statSync(envFile).mode & 0o077) !== 0) {
    process.stderr.write(`insecure: ${envFile} is readable by group/other. Run: chmod 600 ${envFile}\n`);
    process.exitCode = 1;
    return;
  }
  let ring: Keyring;
  try {
    ring = loadKeyring();
    if (decryptSecret(ring, "vault.selftest", encryptSecret(ring, "vault.selftest", "x")) !== "x") throw new Error("selftest");
  } catch {
    process.stderr.write("missing_key: VAULT_MASTER_KEY is absent or malformed in .env.local. Run `npm run vault:init` on a fresh install, or restore the key from your backup.\n");
    process.exitCode = 1;
    return;
  }
  if (!process.env.DATABASE_URL && !process.env.MIGRATE_DATABASE_URL) {
    process.stdout.write("ok (key loads; no database configured, stored secrets not checked)\n");
    return;
  }
  const pool = process.env.DATABASE_URL ? getPool() : getMigratePool();
  try {
    const s = await vaultStatus(pool, ring);
    if (s.status === "ok") {
      process.stdout.write("ok\n");
    } else {
      process.stderr.write(`${s.status}: ${s.unreadable.length} secret(s) cannot be decrypted: ${s.unreadable.join(", ")}\n`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}
main().catch((err: unknown) => {
  process.stderr.write(`failed: ${err instanceof Error ? err.constructor.name : "unknown error"}\n`);
  process.exitCode = 1;
});
