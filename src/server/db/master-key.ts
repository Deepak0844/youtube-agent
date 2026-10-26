// Loads the vault keyring from the environment. The master key lives in .env.local as VAULT_MASTER_KEY (base64, 32 bytes);
// Next loads that file itself, CLI scripts load it via `--env-file-if-exists=.env.local` (see package.json).
// VAULT_MASTER_KEY_PREVIOUS is optional and used only during rotation (decrypt-only).
// Importing this from client code is blocked by an eslint rule (eslint.config.mjs).
import { makeKeyring, type Keyring } from "@/server/core/vault-crypto";

const NAMES = ["VAULT_MASTER_KEY", "VAULT_MASTER_KEY_PREVIOUS"] as const;
let cached: Keyring | undefined;

/**
 * With the default (process.env) the key variables are read ONCE, then deleted from process.env so child processes
 * (render/tool sandboxes, spawned CLIs) do not inherit them, and the parsed keyring is cached in memory.
 * An injected env (tests) is read as-is: no deletion, no caching.
 */
export function loadKeyring(env?: Record<string, string | undefined>): Keyring {
  if (env) return build(env);
  if (cached) return cached;
  const taken = { VAULT_MASTER_KEY: process.env.VAULT_MASTER_KEY, VAULT_MASTER_KEY_PREVIOUS: process.env.VAULT_MASTER_KEY_PREVIOUS };
  for (const n of NAMES) delete process.env[n]; // scrub even if parsing fails below
  return (cached = build(taken));
}

// Empty string is treated as missing; makeKeyring throws a generic VaultError("bad_key") and never echoes the value.
function build(env: Record<string, string | undefined>): Keyring {
  return makeKeyring(env.VAULT_MASTER_KEY ?? "", env.VAULT_MASTER_KEY_PREVIOUS || undefined);
}

export function resetKeyringCacheForTests(): void {
  cached = undefined;
}
