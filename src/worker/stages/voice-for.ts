import type pg from "pg";
import { EDGE_VOICES } from "@/server/core/edge-voices";
import { KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import { KEY_SLOT } from "@/server/core/media-catalog";
import type { Keyring } from "@/server/core/vault-crypto";
import { getPriceRule, resolveRoute } from "@/server/db/media-registry";
import { getSecret } from "@/server/db/vault";
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
      const r = await db.query("select 1 from secrets where name = $1", [secretName(slot as ProviderId)]);
      if (r.rowCount === 0) throw new KnownFailure(`${PICK_VOICE} (save its key first).`);
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
