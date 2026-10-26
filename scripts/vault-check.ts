import { getMigratePool, getPool } from "@/server/db/pool";
import { encryptSecret, decryptSecret } from "@/server/core/vault-crypto";
import { loadKeyring } from "@/server/db/master-key";
import { vaultStatus } from "@/server/db/vault";

// Prints ok | missing_key | wrong_key | unreadable (+ names). Never prints key material or secret values.
async function main(): Promise<void> {
  let ring;
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
