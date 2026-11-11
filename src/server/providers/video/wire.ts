import { readFile, stat } from "node:fs/promises";
import type pg from "pg";
import { KEY_SLOT } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import { secretName, type ProviderId } from "@/server/core/provider-keys";
import type { Keyring } from "@/server/core/vault-crypto";
import { getPriceRule } from "@/server/db/media-registry";
import { getSecret, hasSecret } from "@/server/db/vault";
import { safeJoin, storageRoot } from "@/server/storage/paths";
import { hostedApiFetch } from "../image/wire";
import { safeFetch } from "../net/safe-fetch";
import type { JobCheckers } from "../media-types";
import type { SafeFetch } from "../voice/eleven-types";
import type { VideoProvider } from "./index";
import { createSeedanceJobChecker, createSeedanceVideo } from "./seedance";

type Sf = typeof safeFetch;

const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const PICK = "Pick an AI video provider in Settings → Providers";

/** A result file host: indirect mode (public addresses only), https only, and NO headers at all, so nothing secret can reach it. */
export const videoFileFetch = (sf: Sf = safeFetch): SafeFetch => async (url, init, opts) => {
  if (new URL(url).protocol !== "https:") throw new Error("A result file address must be https.");
  return sf(url, { ...init, headers: undefined }, { ...opts, mode: "indirect", maxRedirects: 0 });
};

/** A start or end picture by path: it must stay inside the storage root, and the size is checked before reading. */
export const readPicture = (root: string) => async (file: string): Promise<Buffer> => {
  let abs: string;
  try {
    abs = await safeJoin(root, file);
  } catch {
    throw new KnownFailure("A start or end picture could not be read.");
  }
  if ((await stat(abs)).size > MAX_PICTURE_BYTES) throw new KnownFailure("A start or end picture is too big.");
  return readFile(abs);
};

const keyReader = (db: pg.Pool, loader: () => Keyring, provider: string) => async (): Promise<string> => {
  const slot = KEY_SLOT[provider];
  return slot ? getSecret(db, loader(), secretName(slot as ProviderId)) : "";
};

/** The routed video provider by registry id: enabled, priced and keyed, or it refuses BEFORE any money is reserved. No fallback to another provider. */
export function createVideoFor(db: pg.Pool, loader: () => Keyring, root: string = storageRoot(), sf: Sf = safeFetch): (providerId: string) => Promise<VideoProvider> {
  const fetch = hostedApiFetch(sf);
  return async (id) => {
    if (id !== "seedance_video") throw new KnownFailure(`${PICK} (${id.slice(0, 40)} is not an AI video provider).`);
    const price = await getPriceRule(db, id);
    if (!price) throw new KnownFailure(`${PICK} (${id} is off or has no price).`);
    if (!(await hasSecret(db, secretName(KEY_SLOT[id] as ProviderId)))) throw new KnownFailure(`${PICK} (save its key first).`);
    return createSeedanceVideo({ fetch, fetchCdn: videoFileFetch(sf), db, getKey: keyReader(db, loader, id), price, root, readImage: readPicture(root) });
  };
}

/** Read-only "check the job" checkers by provider id. Keys are read per check, so building them needs no key. */
export function createVideoJobCheckers(db: pg.Pool, loader: () => Keyring, root: string = storageRoot(), sf: Sf = safeFetch): JobCheckers {
  return { seedance_video: createSeedanceJobChecker({ fetch: hostedApiFetch(sf), fetchCdn: videoFileFetch(sf), getKey: keyReader(db, loader, "seedance_video"), root }) };
}
