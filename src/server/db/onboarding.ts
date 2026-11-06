import type pg from "pg";
import { PROVIDERS } from "@/server/core/provider-keys";
import type { OnboardingFacts } from "@/server/core/onboarding";
import { getOwnGoogleApp } from "@/server/db/google-app";
import { listRoutes } from "@/server/db/llm-models";
import { loadKeyring } from "@/server/db/master-key";
import { getVaultState, listProviderKeys } from "@/server/db/provider-keys";
import { listAccounts } from "@/server/db/youtube-channels";

const LLM = new Set<string>(PROVIDERS.filter((p) => p.role === "Language model").map((p) => p.id));

/** Read-only: reads saved settings. It never uses a key and never calls a provider. */
export async function loadOnboardingFacts(db: pg.Pool): Promise<OnboardingFacts> {
  const [keys, routes, app, accounts, vault] = await Promise.all([
    listProviderKeys(db),
    listRoutes(db),
    getOwnGoogleApp(db),
    listAccounts(db),
    getVaultState(db, loadKeyring).catch(() => "unreadable" as const),
  ]);
  return {
    llmKeySaved: keys.some((k) => k.isSet && LLM.has(k.id)),
    modelChosen: Object.keys(routes).length > 0,
    googleAppSaved: !!app && app.secretStored,
    channelConnected: accounts.some((a) => a.channels.some((c) => c.status === "connected")),
    vaultReadable: vault === "ok",
  };
}
