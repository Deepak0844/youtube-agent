import type pg from "pg";
import { KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import type { Keyring } from "@/server/core/vault-crypto";
import { getSetting } from "@/server/db/settings";
import { loadLocalServices } from "@/server/db/system-settings";
import { getSecret, hasSecret } from "@/server/db/vault";
import { createVoiceStudioStt, type Transcriber } from "@/server/providers/stt/voicestudio-stt";
import { assertVoiceStudioUrl } from "@/server/providers/voice/voicestudio";

/**
 * The speech-to-text for uploaded clip sources: the owner's VoiceStudio (the address saved in Settings, on this computer unless a key is saved
 * and the address is https). Refuses in plain words BEFORE any audio is sent when the address is missing or unsafe. Same address rules as narration.
 */
export function createTranscriberFor(db: pg.Pool, loader: () => Keyring): () => Promise<Transcriber> {
  return async () => {
    const baseUrl = String(await getSetting(db, "voice.voicestudio_url"));
    if (!baseUrl) throw new KnownFailure("Set the VoiceStudio address in Settings → Providers: it listens to uploaded videos.");
    const keySaved = await hasSecret(db, secretName("voicestudio" as ProviderId));
    assertVoiceStudioUrl(baseUrl, keySaved);
    const localServices = await loadLocalServices(db);
    return createVoiceStudioStt({ baseUrl, localServices, getKey: async () => (keySaved ? getSecret(db, loader(), secretName("voicestudio" as ProviderId)) : null) });
  };
}
