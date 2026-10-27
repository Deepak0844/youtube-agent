import type pg from "pg";
import { VaultError, type Keyring } from "@/server/core/vault-crypto";
import { secretName } from "@/server/core/provider-keys";
import { localServices } from "@/server/db/llm-models";
import { getSecret } from "@/server/db/vault";
import { buildModel, type BuildOptions } from "./model-factory";
import { keySlotFor } from "./provider-endpoints";
import type { ProviderId } from "@/server/core/llm-catalog";

// Production wiring for the LLM layer: the key comes from the vault, decrypted per request (the model factory calls
// `getKey` inside each HTTP request and drops the value); the model is built from the catalog row with the owner's
// current local-service list. `loader` is the keyring loader (`loadKeyring` in the app; a fake ring in tests).
// `extra` is for tests (a fake transport); production passes nothing.

export async function defaultModelDeps(
  db: pg.Pool,
  loader: () => Keyring,
  extra: Pick<BuildOptions, "fetch" | "lookup" | "env" | "ownPorts"> = {},
): Promise<{
  getKey(provider: string): Promise<string | null>;
  buildModel: (row: Parameters<typeof buildModel>[0], getKey: () => Promise<string | null>) => ReturnType<typeof buildModel>;
}> {
  const local = await localServices(db);
  return {
    async getKey(provider) {
      const slot = keySlotFor(provider as ProviderId);
      if (slot === null) return null;
      try {
        return await getSecret(db, loader(), secretName(slot));
      } catch (err) {
        if (err instanceof VaultError && err.code === "not_found") return null; // "No key saved for ..."
        throw err; // wrong master key, unreadable entry: the factory turns this into a plain sentence and drops the cause
      }
    },
    buildModel: (row, getKey) => buildModel(row, getKey, { localServices: local, ...extra }),
  };
}
