import { quote as priceQuote, type PriceRule } from "@/server/core/media-catalog";
import { KnownFailure } from "@/server/core/paid-call";
import type { Db } from "@/server/db/stages";
import { runAsyncMedia, stepOfKey } from "../async-media";
import type { Aspect, ImageProvider } from "../media";
import type { SafeFetch } from "../voice/eleven-types";
import { postJson, readCapped } from "../voice/elevenlabs";
import { checkImage, readKey, saveImage } from "./index";

export interface FalImageDeps {
  /** Typed host queue.fal.run. */
  fetch: SafeFetch;
  /** Indirect (public-address-only) fetch for the CDN; it never gets the key. */
  fetchCdn: SafeFetch;
  db: Db;
  /** Decrypted per call; never cached or logged. */
  getKey: () => Promise<string>;
  /** The `fal_image` registry price; null = unpriced, refused. */
  price: PriceRule | null;
  budgetScopes: string[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const HOST = "https://queue.fal.run";
// model id -> the owner/app part of the status and result URLs (fal docs: the endpoint path 405s there).
const APPS: Record<string, string> = { "fal-ai/flux/schnell": "fal-ai/flux" };
// Pixels stay under 1 megapixel (billed per megapixel, rounded up), so one image is one unit.
const SIZE: Record<Aspect, { width: number; height: number }> = { "9:16": { width: 576, height: 1024 }, "16:9": { width: 1024, height: 576 }, "1:1": { width: 960, height: 960 } };
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/** fal serves results from fal.media (v3.fal.media, ...): https only, no credentials or port. */
export function falCdnUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("fal returned an unusable file address.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !(u.hostname === "fal.media" || u.hostname.endsWith(".fal.media"))) throw new Error("fal returned a file address outside its own host.");
  return u.href;
}

export function createFalImage(deps: FalImageDeps): ImageProvider {
  const capability: ImageProvider["capability"] = { id: "fal_image", refImages: false, seed: true, aspects: ["9:16", "16:9", "1:1"], maxRefs: 0 };
  const check = (a: { prompt?: string; aspect: string; refs?: string[]; seed?: number; model: string }) => {
    if (!Object.hasOwn(APPS, a.model)) throw new KnownFailure(`fal image model "${a.model.slice(0, 60)}" is not supported.`);
    return checkImage(capability, deps.price, { prompt: a.prompt ?? "x", aspect: a.aspect, refs: a.refs, seed: a.seed });
  };
  const quote: ImageProvider["quote"] = (a) => {
    check({ ...a, refs: new Array(a.refs).fill("") });
    return priceQuote(deps.price as PriceRule, 1);
  };

  // Every call after the submit is a plain Error on failure: the job exists and may bill.
  async function get(f: SafeFetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Buffer> {
    let res: Response;
    try {
      res = await f(url, { method: "GET", headers, signal }, { timeoutMs: 120_000, maxRedirects: 0 });
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new Error("fal request failed after the job was submitted.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`fal answered ${res.status}; the outcome is unknown.`);
    }
    return readCapped(res, "fal");
  }

  return {
    capability,
    quote,
    async generate(ctx, a) {
      const prompt = check(a);
      const reserve = quote({ aspect: a.aspect, refs: 0, model: a.model });
      const app = APPS[a.model]!;
      const meta = { provider: "fal_image", model: a.model, prompt, refs: [] as string[], seed: a.seed, aspect: a.aspect };
      return ctx.paid({ reserveMicroUsd: reserve, budgetScopes: deps.budgetScopes, kind: "paid" }, async (callKey, signal) => {
        const auth = async () => ({ authorization: `Key ${await readKey(deps.getKey, "fal")}` });
        const result = await runAsyncMedia(ctx, { db: deps.db, provider: "fal_image", kind: "image", step: stepOfKey(callKey), quoteMicroUsd: reserve, signal, sleep: deps.sleep }, {
          async submit() {
            const res = await postJson("fal", deps.fetch, `${HOST}/${a.model}`, await auth(), { prompt, image_size: SIZE[a.aspect], num_images: 1, enable_safety_checker: true, ...(a.seed !== undefined && { seed: a.seed }) }, signal);
            const id = (JSON.parse((await readCapped(res, "fal")).toString("utf8")) as { request_id?: unknown }).request_id;
            if (typeof id !== "string" || !REQUEST_ID.test(id)) throw new Error("fal returned no usable job id.");
            return id;
          },
          async poll(id) {
            const base = `${HOST}/${app}/requests/${id}`;
            const st = JSON.parse((await get(deps.fetch, `${base}/status`, await auth(), signal)).toString("utf8")) as { status?: unknown; error?: unknown };
            if (st.error) throw new Error("fal reported the job failed; the outcome is unknown.");
            if (st.status === "IN_QUEUE" || st.status === "IN_PROGRESS") return null;
            if (st.status !== "COMPLETED") throw new Error("fal reported an unknown job state.");
            const out = JSON.parse((await get(deps.fetch, base, await auth(), signal)).toString("utf8")) as { images?: Array<{ url?: unknown }> };
            return falCdnUrl(out.images?.[0]?.url);
          },
          download: (url) => get(deps.fetchCdn, falCdnUrl(url), {}, signal), // no key to the CDN
          save: (bytes) => saveImage(ctx, bytes, { ...meta, priceMicroUsd: reserve }),
        });
        return { result, actualMicroUsd: reserve };
      });
    },
  };
}
