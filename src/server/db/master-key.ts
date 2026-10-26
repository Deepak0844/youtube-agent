// Loads the vault keyring from the environment. The master key lives in .env.local as VAULT_MASTER_KEY (base64, 32 bytes);
// Next loads that file itself, CLI scripts load it via `--env-file-if-exists=.env.local` (see package.json).
// VAULT_MASTER_KEY_PREVIOUS is optional and used only during rotation (decrypt-only).
import { makeKeyring, type Keyring } from "@/server/core/vault-crypto";

export function loadKeyring(env: Record<string, string | undefined> = process.env): Keyring {
  // Empty string is treated as missing; makeKeyring throws a generic VaultError("bad_key") and never echoes the value.
  return makeKeyring(env.VAULT_MASTER_KEY ?? "", env.VAULT_MASTER_KEY_PREVIOUS || undefined);
}
