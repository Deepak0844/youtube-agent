import { readFile, stat } from "node:fs/promises";
import type pg from "pg";
import { KEY_SLOT } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import type { Keyring } from "@/server/core/vault-crypto";
import { getAsset } from "@/server/db/assets";
import { getPriceRule } from "@/server/db/media-registry";
import { getSecret, hasSecret } from "@/server/db/vault";
import { storageRoot, safeJoin } from "@/server/storage/paths";
import type { ImageProvider } from "../media";
import type { JobCheckers } from "../media-types";
import { safeFetch } from "../net/safe-fetch";
import type { SafeFetch } from "../voice/eleven-types";
import { createFalJobChecker, createFalImage, falCdnUrl } from "./fal";
import { createGeminiImage } from "./gemini";
import { createOpenAIImage } from "./openai";

type Sf = typeof safeFetch;

/** Hosted API calls: fixed https hosts, typed mode with no local services; the adapter's per-call options (no redirects, timeout) are forwarded. */
export const hostedApiFetch = (sf: Sf = safeFetch): SafeFetch => (url, init, opts) => sf(url, init, { ...opts, mode: "typed", localServices: [], maxRedirects: 0 });

/**
 * The fal file host: indirect mode (public addresses only), https and *.fal.media only, and the key is never sent. The adapter
 * caps the body size while reading it (readCapped); redirects are refused by the adapter (maxRedirects 0).
 */
export const falCdnFetch = (sf: Sf = safeFetch): SafeFetch => async (url, init, opts) => {
  const checked = falCdnUrl(url);
  return sf(checked, { ...init, headers: undefined }, { ...opts, mode: "indirect", maxRedirects: 0 }); // no headers at all: nothing secret can reach the file host
};

const MAX_REF_BYTES = 10 * 1024 * 1024;

/** An asset's file bytes for a reference image: the path must stay inside the storage root and the size is checked before reading. */
export const readAssetRef = (db: pg.Pool, root: string) => async (assetId: string): Promise<Buffer> => {
  const a = await getAsset(db, assetId);
  if (!a) throw new KnownFailure("A reference image no longer exists.");
  let file: string;
  try {
    file = await safeJoin(root, a.storageRef);
  } catch {
    throw new KnownFailure("A reference image could not be read.");
  }
  if ((await stat(file)).size > MAX_REF_BYTES) throw new KnownFailure("A reference image is too big.");
  return readFile(file);
};

const PICK = "Pick an image provider in Settings → Providers";

/** The keyed vault read, per call. */
const keyReader = (db: pg.Pool, loader: () => Keyring, provider: string) => async (): Promise<string> => {
  const slot = KEY_SLOT[provider];
  return slot ? getSecret(db, loader(), secretName(slot as ProviderId)) : "";
};

/**
 * The routed image provider by registry id: it must be enabled and priced and its key saved. Everything refuses BEFORE any
 * money is reserved; no fallback to another provider.
 */
export function createImageFor(db: pg.Pool, loader: () => Keyring, root: string = storageRoot(), sf: Sf = safeFetch): (providerId: string) => Promise<ImageProvider> {
  const fetch = hostedApiFetch(sf);
  return async (id) => {
    if (id !== "gemini_image" && id !== "openai_image" && id !== "fal_image") throw new KnownFailure(`${PICK} (${id.slice(0, 40)} is not an image provider).`);
    const price = await getPriceRule(db, id);
    if (!price) throw new KnownFailure(`${PICK} (${id} is off or has no price).`);
    if (!(await hasSecret(db, secretName(KEY_SLOT[id] as ProviderId)))) throw new KnownFailure(`${PICK} (save its key first).`);
    const getKey = keyReader(db, loader, id);
    if (id === "openai_image") return createOpenAIImage({ fetch, getKey, price, root });
    if (id === "fal_image") return createFalImage({ fetch, fetchCdn: falCdnFetch(sf), db, getKey, price, root });
    return createGeminiImage({ fetch, getKey, price, root, readRef: readAssetRef(db, root) });
  };
}

/** Read-only "check the job" checkers by provider id. Keys are read per check, so building them needs no key; used by the web app and the queue page. */
export function createJobCheckers(db: pg.Pool, loader: () => Keyring, root: string = storageRoot(), sf: Sf = safeFetch): JobCheckers {
  return { fal_image: createFalJobChecker({ fetch: hostedApiFetch(sf), fetchCdn: falCdnFetch(sf), getKey: keyReader(db, loader, "fal_image"), root }) };
}
