import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateMasterKey } from "@/server/core/vault-crypto";

// Generates VAULT_MASTER_KEY and appends it to .env.local (override path with VAULT_ENV_FILE, used by tests).
// Refuses if a VAULT_MASTER_KEY line already exists in any form (even empty): replacing the key would orphan every stored secret.
// The key is never printed.
const file = process.env.VAULT_ENV_FILE || ".env.local";
const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
if (/^\s*(export\s+)?VAULT_MASTER_KEY\s*=/m.test(existing)) {
  process.stderr.write(`refused: ${file} already defines VAULT_MASTER_KEY. Overwriting it would make stored secrets unreadable.\n`);
  process.exit(1);
}
const sep = existing === "" || existing.endsWith("\n") ? "" : "\n";
writeFileSync(file, `${existing}${sep}VAULT_MASTER_KEY=${generateMasterKey()}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
process.stdout.write(
  [
    `VAULT_MASTER_KEY written to ${file} (mode 0600). The key is not shown.`,
    "BACK IT UP NOW: copy that line into your password manager. If the key is lost, every stored secret is unrecoverable.",
    "Keep .env.local out of git (it is gitignored) and out of screenshots, logs and chat.",
    "Run `npm run vault:check` to verify.",
    "",
  ].join("\n"),
);
