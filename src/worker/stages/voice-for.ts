import type pg from "pg";
import { EDGE_VOICES } from "@/server/core/edge-voices";
import { KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { KEY_SLOT } from "@/server/core/media-catalog";
import type { Keyring } from "@/server/core/vault-crypto";
import { getPriceRule, resolveRoute } from "@/server/db/media-registry";
import { getSetting } from "@/server/db/settings";
import { loadLocalServices } from "@/server/db/system-settings";
import { createAzureVoice } from "@/server/providers/voice/azure";
import { createOpenAiCompatibleVoice } from "@/server/providers/voice/openai-compatible";
import { assertVoiceStudioUrl, isLoopbackHost, createVoiceStudioVoice } from "@/server/providers/voice/voicestudio";
import { getSecret, hasSecret } from "@/server/db/vault";
import { safeFetch } from "@/server/providers/net/safe-fetch";
import { createEdgeVoice, connectEdge } from "@/server/providers/voice/edge";
import { createElevenLabsVoice } from "@/server/providers/voice/elevenlabs";
import { createGoogleVoice } from "@/server/providers/voice/google";
import { alignChunk, type ChildRunner } from "@/server/render/whisper";
import type { VoiceChoice, StageDeps } from "./deps";

export const PICK_VOICE = "Pick a voice provider in Settings → Providers";

/** Hosted providers are fixed https hosts: typed mode with no local services, and the per-call options (no redirects, 120 s) are FORWARDED. */
export const makeHostedFetch = (sf: typeof safeFetch) => (url: string, init: RequestInit, opts: { timeoutMs: number; maxRedirects: number }): Promise<Response> =>
  sf(url, init, { mode: "typed", localServices: [], ...opts });
export const hostedFetch = makeHostedFetch(safeFetch);

/**
 * The routed narration voice: route for (format, kind), the provider must be enabled and priced, and a key must be saved when it needs one.
 * Everything here refuses BEFORE any line is reserved. No route, no silent fallback to another provider.
 */
export function createVoiceFor(db: pg.Pool, loader: () => Keyring, fetchFn: typeof hostedFetch = hostedFetch): StageDeps["voiceFor"] {
  return async ({ lang, format, kind, budgetScopes }): Promise<VoiceChoice> => {
    const route = await resolveRoute(db, "voice", { format, videoKind: kind });
    if (!route) throw new KnownFailure(`${PICK_VOICE} (no voice is chosen for this kind of video).`);
    const price = await getPriceRule(db, route.provider);
    if (!price) throw new KnownFailure(`${PICK_VOICE} (${route.provider} is off or has no price).`);
    const slot = KEY_SLOT[route.provider];
    const getKey = async (): Promise<string> => {
      if (!slot) return "";
      return getSecret(db, loader(), secretName(slot as ProviderId));
    };
    const needKey = async () => {
      if (!slot) return;
      if (!(await hasSecret(db, secretName(slot as ProviderId)))) throw new KnownFailure(`${PICK_VOICE} (save its key first).`);
    };
    switch (route.provider) {
      case "elevenlabs": {
        await needKey();
        if (!route.voice) throw new KnownFailure(`${PICK_VOICE} (choose an ElevenLabs voice).`);
        const model = route.model ?? "eleven_multilingual_v2";
        return { provider: createElevenLabsVoice({ fetch: fetchFn, getKey, model, voiceId: route.voice, price, budgetScopes }), providerId: "elevenlabs", voice: route.voice, model };
      }
      case "google_tts": {
        await needKey();
        if (!route.voice) throw new KnownFailure(`${PICK_VOICE} (choose a Google voice).`);
        return { provider: createGoogleVoice({ fetch: fetchFn, getKey, price, budgetScopes }), providerId: "google_tts", voice: route.voice, ...(route.model && { model: route.model }) };
      }
      case "edge":
        return { provider: createEdgeVoice({ connect: connectEdge }), providerId: "edge", voice: route.voice ?? EDGE_VOICES[lang] };
      case "azure_tts": {
        await needKey();
        const region = String(await getSetting(db, "voice.azure_region"));
        if (!region) throw new KnownFailure(`${PICK_VOICE} (set the Azure region).`);
        if (!route.voice) throw new KnownFailure(`${PICK_VOICE} (choose an Azure voice).`);
        return { provider: createAzureVoice({ fetch: fetchFn, getKey, price, budgetScopes, region }), providerId: "azure_tts", voice: route.voice };
      }
      case "local_openai":
      case "voicestudio": {
        const isLocal = route.provider === "local_openai";
        const baseUrl = String(await getSetting(db, isLocal ? "voice.local_url" : "voice.voicestudio_url"));
        if (!baseUrl) throw new KnownFailure(`${PICK_VOICE} (set the ${isLocal ? "local voice server" : "VoiceStudio"} address).`);
        if (!route.voice) throw new KnownFailure(`${PICK_VOICE} (choose a voice).`);
        const keySaved = Boolean(slot) && (await hasSecret(db, secretName(slot as ProviderId)));
        try {
          new URL(baseUrl);
        } catch {
          throw new KnownFailure(`${PICK_VOICE} (the ${isLocal ? "local voice server" : "VoiceStudio"} address is not a valid URL).`);
        }
        if (!isLocal) assertVoiceStudioUrl(baseUrl, keySaved);
        else if (keySaved) {
          const u = new URL(baseUrl);
          if (u.protocol !== "https:" && !isLoopbackHost(u.hostname)) throw new KnownFailure(`${PICK_VOICE} (a key must not be sent over plain http to another computer; use an https address).`);
        }
        const localServices = await loadLocalServices(db);
        const optKey = async () => (keySaved ? getKey() : null);
        const provider = isLocal
          ? createOpenAiCompatibleVoice({ baseUrl, localServices, model: route.model ?? "default", voice: route.voice, getKey: optKey, budgetScopes, wordTimings: "estimated" })
          : createVoiceStudioVoice({ baseUrl, localServices, voice: route.voice, getKey: optKey, budgetScopes });
        return { provider, providerId: route.provider, voice: route.voice, ...(route.model && { model: route.model }) };
      }
      default:
        throw new KnownFailure(`${PICK_VOICE} (${route.provider} is not set up for narration yet).`);
    }
  };
}

/** Whisper word alignment when WHISPER_MODEL names the model file; without it the stage falls back to estimated (approximate) times. */
export function whisperAligner(runChild: ChildRunner, env: NodeJS.ProcessEnv = process.env): StageDeps["align"] {
  const modelPath = env.WHISPER_MODEL;
  return modelPath ? (a) => alignChunk({ runChild, modelPath }, a) : undefined;
}
